// Signing keys on this device, kept in the OS keystore (Android Keystore /
// iOS Keychain / Windows DPAPI / libsecret). One record per network.
import 'dart:convert';
import 'dart:typed_data';

import 'package:convert/convert.dart' show hex;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'chain.dart';
import 'send.dart';
import 'wallet.dart';

/// A send that was signed and saved but not seen through to the end.
class Pending {
  final String recipient;
  final BigInt amount;
  final VaultKeys next;
  Pending(this.recipient, this.amount, this.next);
}

class Keys {
  final EdKey payer;
  VaultKeys vault;
  Pending? pending;
  Keys(this.payer, this.vault, [this.pending]);

  Map<String, dynamic> toJson() => {
        'payer': hex.encode(payer.seed),
        'vault': vault.toJson(),
        if (pending != null)
          'pending': {'to': pending!.recipient, 'amount': '${pending!.amount}', 'next': pending!.next.toJson()},
      };

  factory Keys.fromJson(Map<String, dynamic> j) {
    final p = j['pending'] as Map<String, dynamic>?;
    return Keys(
      EdKey(Uint8List.fromList(hex.decode(j['payer'] as String))),
      VaultKeys.fromJson(j['vault'] as Map<String, dynamic>),
      p == null ? null : Pending(p['to'] as String, BigInt.parse(p['amount'] as String),
          VaultKeys.fromJson(p['next'] as Map<String, dynamic>)),
    );
  }
}

class KeyStore {
  KeyStore(this.network);
  final String network;
  static const _s = FlutterSecureStorage();
  String get _k => 'keys-$network';

  Future<Keys?> load() async {
    final v = await _s.read(key: _k);
    if (v == null) return null;
    final k = Keys.fromJson(jsonDecode(v) as Map<String, dynamic>);
    // Stopped before the one-time signature left the device: nothing to finish.
    if (k.pending != null && k.vault.signed == null) {
      k.pending = null;
      await save(k);
    }
    return k;
  }

  Future<void> save(Keys k) => _s.write(key: _k, value: jsonEncode(k.toJson()));
  Future<void> clear() => _s.delete(key: _k);

  /// New fee key and new vault keys.
  Future<Keys> create() async {
    final k = Keys(EdKey.fresh(), VaultKeys.fresh(EdKey.fresh()));
    await save(k);
    return k;
  }

  /// A vault file written by the QC CLI (client/keys/vault-*.json). A used key is refused.
  Future<Keys> importCli(String json, {EdKey? payer}) async {
    final v = VaultKeys.fromCli(json);
    if (v.signed != null || (jsonDecode(json) as Map<String, dynamic>)['used'] == true) {
      throw StateError('This key already signed a transfer. Import the vault it rotated to.');
    }
    final k = Keys(payer ?? EdKey.fresh(), v);
    await save(k);
    return k;
  }

  /// Sends [amount] to [recipient]. The remainder rotates to fresh keys, which
  /// become the vault. Everything is saved before anything is broadcast.
  /// A send that fails before its one-time signature is broadcast is dropped,
  /// so a typo can be corrected; after that it can only be finished.
  Future<String> send(Keys k, Chain chain, String recipient, BigInt amount, {void Function(SendStep)? onStep}) async {
    k.pending ??= Pending(recipient, amount, VaultKeys.fresh(k.vault.owner));
    final p = k.pending!;
    if (p.recipient != recipient || p.amount != amount) {
      throw StateError('Finish the unfinished transfer first.');
    }
    try {
      final sig = await sendQc(
        chain: chain, payer: k.payer, from: k.vault, next: p.next, recipient: recipient, amount: amount,
        persist: () => save(k), onStep: onStep,
      );
      await _finish(k);
      return sig;
    } catch (_) {
      if (k.vault.signed == null) {
        k.pending = null;
        await save(k);
      }
      rethrow;
    }
  }

  /// After a crash or a confirm timeout: the spend landed iff the old vault is
  /// now the program-owned spent marker. The next vault's balance is no proof:
  /// sending the whole balance leaves it empty, and the app would then keep
  /// showing the spent vault, whose address locks anything sent to it.
  Future<bool> settleIfLanded(Keys k, Chain chain) async {
    if (k.pending == null) return false;
    try {
      if (await chain.accountOwner((await k.vault.vault()).$1) == qcProgram) { await _finish(k); return true; }
    } on ChainError { /* RPC unreachable; checked again on next load */ }
    return false;
  }

  Future<void> _finish(Keys k) async {
    k.vault = k.pending!.next;
    k.pending = null;
    await save(k);
  }
}

/// "12.5" -> base units. Null if malformed or too many decimals.
BigInt? parseUnits(String s) {
  final m = RegExp(r'^(\d+)(?:[.,](\d+))?$').firstMatch(s.trim().replaceAll(' ', ''));
  if (m == null) return null;
  final frac = m.group(2) ?? '';
  if (frac.length > Chain.decimals) return null;
  return BigInt.parse(m.group(1)! + frac.padRight(Chain.decimals, '0'));
}
