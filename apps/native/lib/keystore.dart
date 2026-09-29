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
    return v == null ? null : Keys.fromJson(jsonDecode(v) as Map<String, dynamic>);
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
    if (v.signed != null) throw StateError('This key already signed a transfer. Import the vault it rotated to.');
    final k = Keys(payer ?? EdKey.fresh(), v);
    await save(k);
    return k;
  }

  /// Sends [amount] to [recipient]. The remainder rotates to fresh keys, which
  /// become the vault. Everything is saved before anything is broadcast.
  Future<String> send(Keys k, Chain chain, String recipient, BigInt amount, {void Function(SendStep)? onStep}) async {
    k.pending ??= Pending(recipient, amount, VaultKeys.fresh(k.vault.owner));
    final p = k.pending!;
    if (p.recipient != recipient || p.amount != amount) {
      throw StateError('Finish the unfinished transfer first.');
    }
    final sig = await sendQc(
      chain: chain, payer: k.payer, from: k.vault, next: p.next, recipient: recipient, amount: amount,
      persist: () => save(k), onStep: onStep,
    );
    await _finish(k);
    return sig;
  }

  /// After a crash: if the spend already landed, the next vault holds the funds.
  Future<bool> settleIfLanded(Keys k, Chain chain) async {
    final p = k.pending;
    if (p == null) return false;
    final ta = await p.next.vaultTokenAccount();
    try {
      if (await chain.balance([ta]) > BigInt.zero) { await _finish(k); return true; }
    } on ChainError { /* account not created yet */ }
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
