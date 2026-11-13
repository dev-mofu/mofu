// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MofuVerdicts} from "../src/MofuVerdicts.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract MofuVerdictsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MofuVerdicts registry;
    address writer = address(0xBEEF);
    address stranger = address(0xBAD);
    address tokenA = address(0xA);
    address tokenB = address(0xB);

    function setUp() public {
        registry = new MofuVerdicts(writer);
    }

    function pack(uint8 verdict, uint8 flags, uint40 at, bytes16 fp) internal pure returns (uint256) {
        return uint256(verdict) | (uint256(flags) << 8) | (uint256(at) << 16) | (uint256(uint128(fp)) << 56);
    }

    function test_WriterPublishesAndAnyoneReads() public {
        address[] memory tokens = new address[](2);
        tokens[0] = tokenA;
        tokens[1] = tokenB;
        uint256[] memory packed = new uint256[](2);
        packed[0] = pack(1, 0, 1_800_000_000, bytes16(0x282e8b47cfc27b4ba0328b0b37e99100));
        packed[1] = pack(3, 1 | 2, 1_800_000_100, bytes16(0));
        vm.prank(writer);
        registry.setVerdicts(tokens, packed);

        (uint8 v, uint8 f, uint40 at, bytes16 fp) = registry.verdictOf(tokenA);
        require(v == 1 && f == 0 && at == 1_800_000_000, "token A");
        require(fp == bytes16(0x282e8b47cfc27b4ba0328b0b37e99100), "fingerprint");
        (v, f, at,) = registry.verdictOf(tokenB);
        require(v == 3 && f == 3 && at == 1_800_000_100, "token B");
        (v,,,) = registry.verdictOf(address(0xC));
        require(v == 0, "unscanned is 0");
    }

    function test_OnlyWriterPublishes() public {
        address[] memory tokens = new address[](1);
        uint256[] memory packed = new uint256[](1);
        vm.prank(stranger);
        vm.expectRevert(MofuVerdicts.NotWriter.selector);
        registry.setVerdicts(tokens, packed);
    }

    function test_LengthsMustMatch() public {
        address[] memory tokens = new address[](2);
        uint256[] memory packed = new uint256[](1);
        vm.prank(writer);
        vm.expectRevert(MofuVerdicts.LengthMismatch.selector);
        registry.setVerdicts(tokens, packed);
    }

    function test_OwnerRotatesWriter() public {
        registry.setWriter(stranger);
        require(registry.writer() == stranger, "rotated");
        vm.prank(writer);
        vm.expectRevert(MofuVerdicts.NotOwner.selector);
        registry.setWriter(writer);
        vm.expectRevert(MofuVerdicts.ZeroAddress.selector);
        registry.setWriter(address(0));
    }

    function test_OwnershipTransfer() public {
        registry.transferOwnership(stranger);
        require(registry.owner() == stranger, "new owner");
        vm.expectRevert(MofuVerdicts.NotOwner.selector);
        registry.setWriter(address(0x1));
    }
}
