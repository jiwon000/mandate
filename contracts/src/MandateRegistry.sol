// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IRiskGuard, IMandateVaultView, RiskLimits, FeeTerms, ReferenceTerms} from "./interfaces/IMandate.sol";

/// @notice Public catalog of registered mandates and the signed anchor point for
///         DP Reporter releases (mandate-technical-spec-v0.2.md 3.7).
/// @dev Two independent trust levels live in one contract:
///      - registerAgent() checks a (vault, adapter, limits) tuple against the
///        vault's own `riskGuard()` -- never a caller-supplied guard address.
///        [2026-10-04 security review] An earlier version took `guard` as a
///        parameter and only checked internal self-consistency of the
///        (guard, limits, adapter) tuple by calling back into that same
///        caller-chosen address. That let anyone deploy a trivial contract
///        that answers every check with "yes" and permanently occupy a real
///        vault's one-time registry slot with fabricated terms -- the exact
///        claim "there is nothing a caller can lie about" was false, because
///        `vault` itself was never consulted. Deriving `guard` from
///        `vault.riskGuard()` closes exactly that hole: a real vault's
///        `riskGuard()` is immutable from its own construction, so nobody can
///        hijack `agentOf[realVault]` after the fact. It does not prove
///        `vault` is a genuine MandateVault -- a caller can still deploy their
///        own fake vault-plus-guard pair, but doing so only ever writes an
///        entry keyed by an address they themselves control, never one that
///        already belonged to someone else (round-2 review, same date).
///        `fees`/`modelHash` still have no on-chain ground truth to check
///        against, so the call is restricted to the guard's own owner -- the
///        same operator already trusted to configure and lock the vault's
///        terms -- rather than left permissionless.
///      - Once the owner names a canonical guard (setCanonicalGuard), only vaults
///        whose `riskGuard()` is that guard can be registered at all. A vault that
///        points at the canonical guard can only have locked terms there if the
///        guard's owner or the protocol's MandateFactory configured it, and the
///        factory only configures vaults it deployed itself from the reviewed
///        MandateVault code. That closes the gap the round-2 note above left open:
///        a self-deployed fake vault-plus-guard pair is refused outright instead of
///        being cataloged under its own address.
///      - registerFromFactory() is the permissionless path: anyone calls
///        MandateFactory.createMandate(), which deploys, configures, locks and
///        registers in one transaction, recording the caller as the operator.
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

    /// @notice What became of a registered mandate, as read from the chain.
    /// @dev `state` and `reason` mirror MandateVault.AgentState and
    ///      IRiskGuard.freezeOf(). `frozenAt` is the guard's own timestamp for the
    ///      freeze; `recordedAt` is when the last state change was recorded here.
    struct Outcome {
        uint8 state;
        uint8 reason;
        uint64 frozenAt;
        uint64 recordedAt;
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
    error OnlyGuardOwner();
    error ReporterNotConfigured();
    error OnlyReporter();
    error InvalidSignature();
    error EpochNotIncreasing();
    error PinnedBlockNotIncreasing();
    error PinnedBlockInFuture();
    error EpsilonAccountingMismatch();
    error EpsilonCapExceeded();
    error ZeroReporter();
    error NotRegistered();
    error NothingToRecord();
    error OnlyVaultAgent();
    error AlreadyLinked();
    error NotCanonicalGuard();
    error OnlyFactory();
    error AlreadySet();

    address public reporter;
    /// @notice Hard ceiling on cumulative epsilon ever released. 0 means no cap.
    uint256 public epsilonCap;

    /// @notice The only guard whose vaults may be registered, once set. 0 means unset.
    address public canonicalGuard;
    /// @notice The MandateFactory allowed to register the vaults it creates.
    address public factory;
    /// @notice Who registered a vault: the guard owner, or whoever called the factory.
    mapping(address => address) public operatorOf;
    /// @notice Every registered vault, in registration order.
    address[] private registered;

    mapping(address => Agent) public agentOf;
    mapping(address => Outcome) public outcomeOf;
    /// @notice Registered vaults an agent has linked to its own address, in order.
    mapping(address => address[]) private vaultsByAgent;
    mapping(address => bool) public linked;
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
    event OutcomeRecorded(address indexed vault, uint8 state, uint8 reason, uint64 frozenAt);
    event VaultLinked(address indexed agent, address indexed vault);
    event ReporterUpdated(address indexed reporter);
    event CanonicalGuardSet(address indexed guard);
    event FactorySet(address indexed factory);
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

    /// @notice Restrict registration to vaults guarded by `guard`. Once.
    function setCanonicalGuard(address guard) external onlyOwner {
        if (canonicalGuard != address(0)) revert AlreadySet();
        canonicalGuard = guard;
        emit CanonicalGuardSet(guard);
    }

    /// @notice Name the factory whose vaults register through registerFromFactory(). Once.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setEpsilonCap(uint256 cap) external onlyOwner {
        epsilonCap = cap;
        emit EpsilonCapUpdated(cap);
    }

    /// @notice Catalog a mandate. `guard` is read from `vault.riskGuard()`, not
    ///         taken as a parameter, so a real vault's entry can never be hijacked
    ///         by a caller pointing the check at a different (fake) guard. This
    ///         does not prove `vault` is a genuine, reviewed MandateVault -- that
    ///         remains the same trusted-integration-boundary assumption the rest
    ///         of the protocol already makes (docs/batch-allocator-milestone2.md).
    ///         A caller who deploys their own fake vault-plus-guard pair can only
    ///         ever write an entry keyed by an address they themselves control;
    ///         `agentOf[vault]` for any vault that already existed before they
    ///         acted is fixed by that vault's own immutable constructor and is
    ///         unreachable to them (2026-10-04 security review, round 2).
    ///         Reverts unless `limits` is exactly what the guard has locked in
    ///         for `vault` and `adapter` is on its allowlist, so a genuine
    ///         vault's registry entry can never drift from the terms an
    ///         allocator actually signed up for. Only the guard's own owner may
    ///         call this -- `fees`/`modelHash` are declared, not derivable from
    ///         chain state, so unlike the rest of the tuple they need an
    ///         authorization boundary, and the operator who already configured
    ///         and locked the vault's real terms is the natural one. One entry
    ///         per vault, forever -- a changed mandate is a new vault, same rule
    ///         MandateRiskGuard.lockTerms() already enforces.
    function registerAgent(
        address vault,
        address adapter,
        RiskLimits calldata limits,
        FeeTerms calldata fees,
        bytes32 modelHash
    ) external {
        IRiskGuard riskGuard = _guardOf(vault);
        if (msg.sender != Ownable(address(riskGuard)).owner()) revert OnlyGuardOwner();
        // The trade and reference terms are read from the guard, so the caller only
        // restates the limits and fees; a mismatch in either changes the hash.
        ReferenceTerms memory refTerms = riskGuard.referenceTermsOf(vault);
        bytes32 hash = refTerms.maxMarkDeviationBps == 0
            ? keccak256(abi.encode(limits, riskGuard.tradeTermsOf(vault), fees))
            : keccak256(abi.encode(limits, riskGuard.tradeTermsOf(vault), fees, refTerms));
        if (hash != riskGuard.termsHash(vault)) revert TermsMismatch();
        _register(vault, riskGuard, adapter, fees, modelHash, hash, msg.sender);
    }

    /// @notice Catalog a vault MandateFactory just created. Factory only.
    /// @dev The factory deployed `vault` from the reviewed code, configured it on the
    ///      canonical guard and locked it in the same transaction. Fees and the hash
    ///      are read from the guard, so nothing here is taken on the factory's word
    ///      except `modelHash` and who the operator is. When the operator is the
    ///      vault's own agent the vault is linked under it at once.
    function registerFromFactory(address vault, address adapter, bytes32 modelHash, address operator) external {
        if (factory == address(0) || msg.sender != factory) revert OnlyFactory();
        if (canonicalGuard == address(0)) revert NotCanonicalGuard();
        IRiskGuard riskGuard = _guardOf(vault);
        _register(vault, riskGuard, adapter, riskGuard.feesOf(vault), modelHash, riskGuard.termsHash(vault), operator);
        if (operator == IMandateVaultView(vault).agent()) _link(vault, operator);
    }

    function registeredCount() external view returns (uint256) {
        return registered.length;
    }

    /// @notice Registered vaults from `start`, at most `count` of them.
    function registeredVaults(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = registered.length;
        if (start >= total) return page;
        uint256 end = start + count > total ? total : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) page[i - start] = registered[i];
    }

    function _guardOf(address vault) private view returns (IRiskGuard riskGuard) {
        if (agentOf[vault].registeredAt != 0) revert AlreadyRegistered();
        riskGuard = IMandateVaultView(vault).riskGuard();
        if (canonicalGuard != address(0) && address(riskGuard) != canonicalGuard) revert NotCanonicalGuard();
        if (!riskGuard.termsLocked(vault)) revert TermsNotLocked();
    }

    function _register(
        address vault,
        IRiskGuard riskGuard,
        address adapter,
        FeeTerms memory fees,
        bytes32 modelHash,
        bytes32 hash,
        address operator
    ) private {
        if (!riskGuard.adapterAllowed(vault, adapter)) revert AdapterNotAllowed();
        agentOf[vault] = Agent({
            guard: address(riskGuard),
            adapter: adapter,
            fees: fees,
            modelHash: modelHash,
            termsHash: hash,
            registeredAt: block.timestamp
        });
        operatorOf[vault] = operator;
        registered.push(vault);
        emit AgentRegistered(vault, address(riskGuard), adapter, hash, modelHash);
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

    /// @notice Record that a registered vault has frozen or closed. Permissionless.
    /// @dev Reads the vault's state and the guard's freeze record directly, so no
    ///      reporter is trusted for a fact the chain already holds. A vault moves
    ///      Active -> Frozen -> Closed, and back from Frozen to Active only through the
    ///      guard's resume(); calling again with nothing new to record reverts.
    function recordOutcome(address vault) external {
        Agent storage entry = agentOf[vault];
        if (entry.registeredAt == 0) revert NotRegistered();
        uint8 state = IMandateVaultView(vault).state();
        Outcome storage outcome = outcomeOf[vault];
        (uint8 reason, uint64 frozenAt) = IRiskGuard(entry.guard).freezeOf(vault);
        // Closed is final. A vault resumed after an unobservable freeze records as
        // Active again, keeping the reason, and a later freeze records over it.
        if (
            outcome.state == 2 || (state == 0 && outcome.state != 1) ||
            (state == outcome.state && frozenAt == outcome.frozenAt)
        ) revert NothingToRecord();
        outcome.state = state;
        outcome.reason = reason;
        outcome.frozenAt = frozenAt;
        outcome.recordedAt = uint64(block.timestamp);
        emit OutcomeRecorded(vault, state, reason, frozenAt);
    }

    /// @notice The vault's own agent lists a registered vault under its address, so
    ///         an allocator sees every mandate that agent has run and how each ended.
    /// @dev Only the agent may link. Registration is done by the guard owner, and
    ///      indexing on vault.agent() alone would let anyone deploy a vault naming
    ///      someone else's address and pin a bad outcome on them. An agent can still
    ///      start over from a new address; the list shows what one address has
    ///      accepted, not who is behind it.
    function linkVault(address vault) external {
        if (agentOf[vault].registeredAt == 0) revert NotRegistered();
        if (IMandateVaultView(vault).agent() != msg.sender) revert OnlyVaultAgent();
        _link(vault, msg.sender);
    }

    function _link(address vault, address agent) private {
        if (linked[vault]) revert AlreadyLinked();
        linked[vault] = true;
        vaultsByAgent[agent].push(vault);
        emit VaultLinked(agent, vault);
    }

    function vaultsOf(address agent) external view returns (address[] memory) {
        return vaultsByAgent[agent];
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
