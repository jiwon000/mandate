// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IBatchVault {
    function asset() external view returns (IERC20);
    function balanceOf(address account) external view returns (uint256);
    function allocate(uint256 assets, address receiver) external returns (uint256);
    function transferShares(address receiver, uint256 shares) external;
}

/// @notice Deposit-only epoch netting for standard, non-rebasing USDC.
/// @dev Signed intents become public at settlement. No anonymity guarantee.
contract BatchAllocator is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    struct AllocationIntent {
        address allocator;
        address vault;
        uint256 amount;
        uint256 minShares;
        uint256 epoch;
        uint256 nonce;
        uint256 deadline;
    }
    struct SignedIntent { AllocationIntent intent; bytes signature; }
    struct BatchNetAllocation { address vault; SignedIntent[] intents; }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "AllocationIntent(address allocator,address vault,uint256 amount,uint256 minShares,uint256 epoch,uint256 nonce,uint256 deadline)"
    );
    uint256 public constant MAX_INTENTS = 128;
    IERC20 public immutable asset;
    address public immutable batcher;
    uint256 public immutable genesis;
    uint256 public immutable epochDuration;
    uint256 public immutable settlementWindow;
    uint256 public totalEscrow;
    mapping(address => uint256) public escrowOf;
    mapping(address => bool) public vaultAllowed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(uint256 => bool) public settled;
    mapping(uint256 => bytes32) public intentRootOf;
    mapping(bytes32 => uint256) public claimableShares;
    mapping(address => uint256) public outstandingShares;

    error InvalidConfiguration();
    error InvalidAmount();
    error InsufficientEscrow();
    error UnsupportedToken();
    error OnlyBatcher();
    error InvalidSettlementWindow();
    error EpochAlreadySettled();
    error InvalidBatch();
    error InvalidIntent();
    error NonceUnavailable();
    error InvalidSignature();
    error InvalidRoot();
    error MinimumShares();
    error VaultResultMismatch();
    error InvalidClaim();

    event EscrowDeposited(address indexed allocator, uint256 assets);
    event EscrowWithdrawn(address indexed allocator, uint256 assets);
    event IntentCancelled(address indexed allocator, uint256 nonce);
    event VaultAllowed(address indexed vault, bool allowed);
    event EpochSettled(uint256 indexed epoch, bytes32 intentRoot, uint256 intentCount);
    event VaultAllocated(uint256 indexed epoch, address indexed vault, uint256 assets, uint256 shares);
    event SharesClaimed(bytes32 indexed intentHash, address indexed allocator, address indexed vault, uint256 shares);

    constructor(IERC20 asset_, address batcher_, uint256 duration_, uint256 window_)
        Ownable(msg.sender) EIP712("MandateBatchAllocator", "1")
    {
        if (address(asset_).code.length == 0 || batcher_ == address(0) || duration_ == 0 || window_ == 0) {
            revert InvalidConfiguration();
        }
        asset = asset_;
        batcher = batcher_;
        genesis = block.timestamp;
        epochDuration = duration_;
        settlementWindow = window_;
    }

    function setVaultAllowed(address vault, bool allowed) external onlyOwner {
        if (allowed && (vault.code.length == 0 || address(IBatchVault(vault).asset()) != address(asset))) {
            revert InvalidConfiguration();
        }
        vaultAllowed[vault] = allowed;
        emit VaultAllowed(vault, allowed);
    }

    function epochEnd(uint256 epoch) public view returns (uint256) {
        return genesis + (epoch + 1) * epochDuration;
    }

    function settlementDeadline(uint256 epoch) public view returns (uint256) {
        return epochEnd(epoch) + settlementWindow;
    }

    function depositEscrow(uint256 assets) external nonReentrant {
        if (assets == 0) revert InvalidAmount();
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), assets);
        if (asset.balanceOf(address(this)) != beforeBalance + assets) revert UnsupportedToken();
        escrowOf[msg.sender] += assets;
        totalEscrow += assets;
        emit EscrowDeposited(msg.sender, assets);
    }

    /// @notice Unspent funds are never locked, even before the settlement deadline.
    /// @dev Cancel a live nonce too if its signature must not spend future deposits.
    function withdrawEscrow(uint256 assets) external nonReentrant {
        if (assets == 0) revert InvalidAmount();
        if (escrowOf[msg.sender] < assets) revert InsufficientEscrow();
        escrowOf[msg.sender] -= assets;
        totalEscrow -= assets;
        asset.safeTransfer(msg.sender, assets);
        emit EscrowWithdrawn(msg.sender, assets);
    }

    function cancelIntent(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceUnavailable();
        nonceUsed[msg.sender][nonce] = true;
        emit IntentCancelled(msg.sender, nonce);
    }

    /// @notice EIP-712 digest including chain ID and this contract's address.
    function hashIntent(AllocationIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent)));
    }

    /// @notice The root is recomputed from all verified intents, never trusted as authorization.
    /// @dev Vault groups must be strictly address-sorted. Each vault receives one deposit.
    function settleEpoch(uint256 epoch, bytes32 intentRoot, BatchNetAllocation[] calldata nets)
        external nonReentrant
    {
        if (msg.sender != batcher) revert OnlyBatcher();
        if (settled[epoch]) revert EpochAlreadySettled();
        if (block.timestamp < epochEnd(epoch) || block.timestamp > settlementDeadline(epoch)) {
            revert InvalidSettlementWindow();
        }
        uint256 count;
        for (uint256 i; i < nets.length; ++i) count += nets[i].intents.length;
        if (count == 0 || count > MAX_INTENTS || nets.length > count) revert InvalidBatch();
        bytes32[] memory leaves = new bytes32[](count);
        uint256 cursor;
        address previous;
        settled[epoch] = true;
        for (uint256 i; i < nets.length; ++i) {
            BatchNetAllocation calldata net = nets[i];
            if (net.vault <= previous || !vaultAllowed[net.vault] || net.intents.length == 0) {
                revert InvalidBatch();
            }
            previous = net.vault;
            uint256 assets;
            for (uint256 j; j < net.intents.length; ++j) {
                SignedIntent calldata signed = net.intents[j];
                bytes32 digest = _consume(epoch, net.vault, signed);
                leaves[cursor++] = keccak256(bytes.concat(digest));
                assets += signed.intent.amount;
            }
            _allocate(epoch, net, assets);
        }
        if (_root(leaves) != intentRoot) revert InvalidRoot();
        intentRootOf[epoch] = intentRoot;
        emit EpochSettled(epoch, intentRoot, count);
    }

    function _consume(uint256 epoch, address vault, SignedIntent calldata signed) private returns (bytes32 digest) {
        AllocationIntent calldata intent = signed.intent;
        if (intent.epoch != epoch || intent.vault != vault || intent.allocator == address(0)
            || intent.amount == 0 || block.timestamp > intent.deadline) revert InvalidIntent();
        if (nonceUsed[intent.allocator][intent.nonce]) revert NonceUnavailable();
        digest = hashIntent(intent);
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signed.signature);
        if (error != ECDSA.RecoverError.NoError || signer != intent.allocator) revert InvalidSignature();
        if (escrowOf[intent.allocator] < intent.amount) revert InsufficientEscrow();
        nonceUsed[intent.allocator][intent.nonce] = true;
        escrowOf[intent.allocator] -= intent.amount;
        totalEscrow -= intent.amount;
    }

    function _allocate(uint256 epoch, BatchNetAllocation calldata net, uint256 assets) private {
        IBatchVault vault = IBatchVault(net.vault);
        uint256 beforeShares = vault.balanceOf(address(this));
        uint256 beforeAssets = asset.balanceOf(address(this));
        asset.forceApprove(net.vault, assets);
        uint256 shares = vault.allocate(assets, address(this));
        asset.forceApprove(net.vault, 0);
        if (shares == 0 || vault.balanceOf(address(this)) != beforeShares + shares
            || asset.balanceOf(address(this)) != beforeAssets - assets) revert VaultResultMismatch();
        uint256 cumulativeAssets;
        uint256 assigned;
        for (uint256 j; j < net.intents.length; ++j) {
            AllocationIntent calldata intent = net.intents[j].intent;
            cumulativeAssets += intent.amount;
            uint256 cumulativeShares = Math.mulDiv(cumulativeAssets, shares, assets);
            uint256 entitlement = cumulativeShares - assigned;
            if (entitlement == 0 || entitlement < intent.minShares) revert MinimumShares();
            claimableShares[hashIntent(intent)] = entitlement;
            assigned = cumulativeShares;
        }
        outstandingShares[net.vault] += shares;
        emit VaultAllocated(epoch, net.vault, assets, shares);
    }

    /// @notice Anyone may relay a claim; shares always go to the signed allocator.
    /// @dev No claim expiry or batcher dependency. Disabling a vault cannot block claims.
    function claimShares(AllocationIntent calldata intent, bytes32[] calldata proof) external nonReentrant {
        bytes32 digest = hashIntent(intent);
        uint256 shares = claimableShares[digest];
        if (shares == 0 || !settled[intent.epoch]
            || !MerkleProof.verifyCalldata(proof, intentRootOf[intent.epoch], keccak256(bytes.concat(digest)))) {
            revert InvalidClaim();
        }
        claimableShares[digest] = 0;
        outstandingShares[intent.vault] -= shares;
        IBatchVault(intent.vault).transferShares(intent.allocator, shares);
        emit SharesClaimed(digest, intent.allocator, intent.vault, shares);
    }

    /// @dev Sorted pairs; odd nodes are promoted unchanged. Leaf order follows calldata.
    function _root(bytes32[] memory nodes) private pure returns (bytes32) {
        uint256 length = nodes.length;
        while (length > 1) {
            uint256 next;
            for (uint256 i; i < length; i += 2) {
                if (i + 1 == length) nodes[next++] = nodes[i];
                else {
                    bytes32 a = nodes[i];
                    bytes32 b = nodes[i + 1];
                    nodes[next++] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
                }
            }
            length = next;
        }
        return nodes[0];
    }
}
