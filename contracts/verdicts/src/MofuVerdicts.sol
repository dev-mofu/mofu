// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MofuVerdicts
/// @notice Mofu's Token Scanner verdicts on Robinhood Chain, readable by any contract, wallet or bot.
/// Mofu's writer address publishes a token's verdict when it changes; anyone can read it.
/// A verdict is a reading of what the token's code allows and a simulated sell, not advice.
///
/// verdict: 0 not scanned, 1 clean, 2 caution, 3 risky
/// flags (bits): 1 sell test failed, 2 code matches known honeypots, 4 can mint, 8 can pause,
///               16 can block wallets, 32 upgradeable, 64 copies the $MOFU name
contract MofuVerdicts {
    address public owner;
    address public writer;

    /// verdict | flags << 8 | scannedAt << 16 | fingerprint << 56
    mapping(address => uint256) public packedVerdict;

    event VerdictSet(
        address indexed token, uint8 verdict, uint8 flags, uint40 scannedAt, bytes16 fingerprint
    );
    event WriterChanged(address indexed writer);
    event OwnerChanged(address indexed owner);

    error NotWriter();
    error NotOwner();
    error LengthMismatch();
    error ZeroAddress();

    constructor(address writer_) {
        if (writer_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        writer = writer_;
        emit OwnerChanged(msg.sender);
        emit WriterChanged(writer_);
    }

    /// @notice Publishes verdicts for several tokens at once (Mofu's writer only).
    function setVerdicts(address[] calldata tokens, uint256[] calldata packed) external {
        if (msg.sender != writer) revert NotWriter();
        if (tokens.length != packed.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 p = packed[i];
            packedVerdict[tokens[i]] = p;
            emit VerdictSet(tokens[i], uint8(p), uint8(p >> 8), uint40(p >> 16), bytes16(uint128(p >> 56)));
        }
    }

    /// @notice A token's latest verdict. scannedAt is a Unix time in seconds; 0 means never scanned.
    function verdictOf(address token)
        external
        view
        returns (uint8 verdict, uint8 flags, uint40 scannedAt, bytes16 fingerprint)
    {
        uint256 p = packedVerdict[token];
        return (uint8(p), uint8(p >> 8), uint40(p >> 16), bytes16(uint128(p >> 56)));
    }

    /// @notice Points publishing at a new writer key (owner only), e.g. after rotating it.
    function setWriter(address writer_) external {
        if (msg.sender != owner) revert NotOwner();
        if (writer_ == address(0)) revert ZeroAddress();
        writer = writer_;
        emit WriterChanged(writer_);
    }

    function transferOwnership(address owner_) external {
        if (msg.sender != owner) revert NotOwner();
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerChanged(owner_);
    }
}
