import 'pda.dart';

const _b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

enum AddrCheck { ok, empty, ethereum, invalid, lookalike }

/// Solana addresses are base58 of exactly 32 bytes (32–44 chars). A truncated
/// or mistyped one can still be valid base58, so the decoded length is checked
/// too. Look-alike = same first 4 and last 4 characters as a saved contact but
/// a different middle (address poisoning).
AddrCheck checkAddress(String a, {Iterable<String> contacts = const []}) {
  a = a.trim();
  if (a.isEmpty) return AddrCheck.empty;
  if (RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(a)) return AddrCheck.ethereum;
  if (a.length < 32 || a.length > 44 || a.split('').any((c) => !_b58.contains(c)) || b58decode(a).length != 32) {
    return AddrCheck.invalid;
  }
  for (final c in contacts) {
    if (a != c && a.substring(0, 4) == c.substring(0, 4) &&
        a.substring(a.length - 4) == c.substring(c.length - 4)) {
      return AddrCheck.lookalike;
    }
  }
  return AddrCheck.ok;
}

String short(String a) => a.length > 12 ? '${a.substring(0, 4)}…${a.substring(a.length - 4)}' : a;
