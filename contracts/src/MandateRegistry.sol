// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IRiskGuard, RiskLimits, FeeTerms} from "./interfaces/IMandate.sol";

/// @notice Public catalog of registered mandates and the signed anchor point for
///         DP Reporter releases (mandate-technical-spec-v0.2.md 3.7).
/// @dev Two independent trust levels live in one contract:
///      - registerAgent() is permissionless and self-verifying: it only accepts a
///        (vault, guard, adapter, limits) tuple that already matches the vault's
///        own locked, on-chain terms, so there is nothing a caller can lie about.
///        Calling it for someone else's vault just publishes the truth earlier.
///      - postLeaderboard() is the one privileged call. A DP statistic and the
///        epsilon spent computing it are not independently checkable on-chain, so
///        they are only accepted with a signature from a single configured
///        reporter key. Centralizing this is deliberate, not an oversight:
///        mandate-technical-spec-v0.2.md 8 lists "Reporter의 탈중앙화" as a stated
///        v1 non-goal. Like claimShares() in BatchAllocator, the call itself is
///        relay-friendly -- trust lives in the signature, not in who sends the tx.
contract MandateRegistry is Ownable, EIP712 {
    struct Agent {
        address guard;
        address adapter;
        FeeTerms fees;
        bytes32 modelHash;
        bytes32 termsHash;
        uint256 registeredAt;
    }

    struct Release {
        uint256 pinnedBlock;
        bytes32 statsDigest;
        uint256 epsilonPerfE6;
        uint256 epsilonIntentE6;
        uint256 cumulativeEpsilonE6;
    }

    bytes32 public constant RELEASE_TYPEHASH = keccak256(
        "LeaderboardRelease(uint256 epoch,uint256 pinnedBlock,bytes32 statsDigest,uint256 epsilonPerfE6,uint256 epsilonIntentE6,uint256 cumulativeEpsilonE6)"
    );

    error AlreadyRegistered();
    error TermsNotLocked();
    error TermsMismatch();
    error AdapterNotAllowed();
    error ReporterNotConfigured();
    error OnlyReporter();
    error InvalidSignature();
    error EpochNotIncreasing();
    error PinnedBlockNotIncreasing();
    error PinnedBlockInFuture();
    error EpsilonAccountingMismatch();
    error EpsilonCapExceeded();
    error ZeroReporter();

    address public reporter;
    /// @notice Hard ceiling on cumulative epsilon ever released. 0 means no cap.
    uint256 public epsilonCap;

    mapping(address => Agent) public agentOf;
    mapping(uint256 => Release) public releaseOf;
    uint256 public lastEpoch;
    uint256 public lastPinnedBlock;
    uint256 public cumulativeEpsilonE6;
    /// @dev Distinguishes "no release yet" from "epoch 0 was posted", since both
    ///      leave lastEpoch at its default value.
    bool public hasReleased;

    event AgentRegistered(
        address indexed vault,
        address indexed guard,
        address indexed adapter,
        bytes32 termsHash,
        bytes32 modelHash
    );
    event ReporterUpdated(address indexed reporter);
    event EpsilonCapUpdated(uint256 cap);
    event LeaderboardPosted(
        uint256 indexed epoch,
        uint256 pinnedBlock,
        bytes32 statsDigest,
        uint256 epsilonPerfE6,
        uint256 epsilonIntentE6,
        uint256 cumulativeEpsilonE6
    );

    constructor() Ownable(msg.sender) EIP712("MandateRegistry", "1") {}

    function setReporter(address reporter_) external onlyOwner {
        if (reporter_ == address(0)) revert ZeroReporter();
        reporter = reporter_;
        emit ReporterUpdated(reporter_);
    }

    function setEpsilonCap(uint256 cap) external onlyOwner {
        epsilonCap = cap;
        emit EpsilonCapUpdated(cap);
    }

    /// @notice Catalog a mandate. Reverts unless `limits` is exactly what `guard`
    ///         has locked in for `vault` and `adapter` is on its allowlist, so a
    ///         registry entry can never drift from the terms an allocator actually
    ///         signed up for. One entry per vault, forever -- a changed mandate is
    ///         a new vault, same rule MandateRiskGuard.lockTerms() already enforces.
    function registerAgent(
        address vault,
        address guard,
        address adapter,
        RiskLimits calldata limits,
        FeeTerms calldata fees,
        bytes32 modelHash
    ) external {
        if (agentOf[vault].registeredAt != 0) revert AlreadyRegistered();
        IRiskGuard riskGuard = IRiskGuard(guard);
        if (!riskGuard.termsLocked(vault)) revert TermsNotLocked();
        bytes32 hash = keccak256(abi.encode(limits));
        if (hash != riskGuard.termsHash(vault)) revert TermsMismatch();
        if (!riskGuard.adapterAllowed(vault, adapter)) revert AdapterNotAllowed();

        agentOf[vault] = Agent({
            guard: guard,
            adapter: adapter,
            fees: fees,
            modelHash: modelHash,
            termsHash: hash,
            registeredAt: block.timestamp
        });
        emit AgentRegistered(vault, guard, adapter, hash, modelHash);
    }

    /// @notice Anchor a signed DP release. The statistics themselves are computed
    ///         and noised off-chain (mandate-technical-spec-v0.2.md 4); this only
    ///         checks that the one trusted reporter produced them, that a release
    ///         can never replace an earlier one, and that the epsilon ledger adds
    ///         up (core invariants 8 and 9).
    function postLeaderboard(
        uint256 epoch,
        uint256 pinnedBlock,
        bytes32 statsDigest,
        uint256 epsilonPerfE6,
        uint256 epsilonIntentE6,
        uint256 cumulativeEpsilonE6_,
        bytes calldata reporterSig
    ) external {
        if (reporter == address(0)) revert ReporterNotConfigured();
        if (hasReleased && epoch <= lastEpoch) revert EpochNotIncreasing();
        if (hasReleased && pinnedBlock <= lastPinnedBlock) revert PinnedBlockNotIncreasing();
        if (pinnedBlock > block.number) revert PinnedBlockInFuture();
        if (cumulativeEpsilonE6_ != cumulativeEpsilonE6 + epsilonPerfE6 + epsilonIntentE6) {
            revert EpsilonAccountingMismatch();
        }
        if (epsilonCap != 0 && cumulativeEpsilonE6_ > epsilonCap) revert EpsilonCapExceeded();

        bytes32 digest = hashRelease(
            epoch, pinnedBlock, statsDigest, epsilonPerfE6, epsilonIntentE6, cumulativeEpsilonE6_
        );
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, reporterSig);
        if (error != ECDSA.RecoverError.NoError) revert InvalidSignature();
        if (signer != reporter) revert OnlyReporter();

        releaseOf[epoch] = Release({
            pinnedBlock: pinnedBlock,
            statsDigest: statsDigest,
            epsilonPerfE6: epsilonPerfE6,
            epsilonIntentE6: epsilonIntentE6,
            cumulativeEpsilonE6: cumulativeEpsilonE6_
        });
        lastEpoch = epoch;
        lastPinnedBlock = pinnedBlock;
        cumulativeEpsilonE6 = cumulativeEpsilonE6_;
        hasReleased = true;
        emit LeaderboardPosted(epoch, pinnedBlock, statsDigest, epsilonPerfE6, epsilonIntentE6, cumulativeEpsilonE6_);
    }

    /// @notice EIP-712 digest a reporter signs over to authorize postLeaderboard().
    function hashRelease(
        uint256 epoch,
        uint256 pinnedBlock,
        bytes32 statsDigest,
        uint256 epsilonPerfE6,
        uint256 epsilonIntentE6,
        uint256 cumulativeEpsilonE6_
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RELEASE_TYPEHASH,
                    epoch,
                    pinnedBlock,
                    statsDigest,
                    epsilonPerfE6,
                    epsilonIntentE6,
                    cumulativeEpsilonE6_
                )
            )
        );
    }
}
