import 'dart:convert';

import 'package:http/http.dart' as http;

import 'pda.dart';

/// Reads real state from a Solana RPC. Mints come from client/genesis-{network}.json.
class Chain {
  static const mints = {
    'devnet': 'BUoNsFbNU5hxYK5rRoiHkFqonaoaNL836Wo5QgrukAK8',
    'mainnet': 'AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2',
  };
  static const decimals = 5;
  static const networks = {
    'devnet': 'https://api.devnet.solana.com',
    'mainnet': 'https://api.mainnet-beta.solana.com',
  };

  /// [rpc] overrides the public endpoint (public ones throttle hard).
  Chain(this.network, {this.rpc});
  final String network;
  final String? rpc;
  String get mint => mints[network]!;
  String get _url => (rpc?.isNotEmpty ?? false) ? rpc! : networks[network]!;
  int _id = 0;

  // Public RPCs throttle (429) and sometimes stall, so each call gets three tries.
  Future<dynamic> _call(String method, List params) async {
    http.Response? r;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await Future.delayed(Duration(milliseconds: 800 * attempt));
      try {
        r = await http
            .post(Uri.parse(_url),
                headers: {'content-type': 'application/json'},
                body: jsonEncode({'jsonrpc': '2.0', 'id': ++_id, 'method': method, 'params': params}))
            .timeout(const Duration(seconds: 20));
      } on Exception {
        if (attempt == 2) throw ChainError('Network unreachable');
        continue;
      }
      if (r.statusCode == 200) break;
    }
    if (r!.statusCode != 200) throw ChainError('RPC ${r.statusCode}');
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (j['error'] != null) throw ChainError('${j['error']['message']}');
    return j['result'];
  }

  /// The QC token accounts for [owner]. Tries the cheap reads first (its Token-2022
  /// associated account, then [owner] itself as a token account) and only then the
  /// owner scan, which public RPCs often stall on (accounts not made by the ATA program).
  Future<List<String>> tokenAccounts(String owner) async {
    for (final a in [associatedTokenAddress(owner, mint), owner]) {
      final info = await _call('getAccountInfo', [a, {'encoding': 'jsonParsed'}]);
      final parsed = info['value']?['data']?['parsed'];
      if (parsed is Map && parsed['info']?['mint'] == mint) return [a];
    }
    final res = await _call('getTokenAccountsByOwner', [owner, {'mint': mint}, {'encoding': 'jsonParsed'}]);
    return [for (final a in res['value'] as List) a['pubkey'] as String];
  }

  /// Balance in base units (10^-5 QC).
  Future<BigInt> balance(List<String> accounts) async {
    var sum = BigInt.zero;
    for (final a in accounts) {
      final r = await _call('getTokenAccountBalance', [a]);
      sum += BigInt.parse(r['value']['amount'] as String);
    }
    return sum;
  }

  Future<String> latestBlockhash() async =>
      (await _call('getLatestBlockhash', [{'commitment': 'confirmed'}]))['value']['blockhash'] as String;

  /// Program that owns [address], or null if the account doesn't exist.
  Future<String?> accountOwner(String address) async =>
      (await _call('getAccountInfo', [address, {'encoding': 'base64', 'dataSlice': {'offset': 0, 'length': 0}}]))['value']
          ?['owner'] as String?;

  /// Base units held by the Token-2022 account [address] for this network's
  /// mint; zero if it doesn't exist or is anything else.
  Future<BigInt> tokenAmount(String address) async {
    final v = (await _call('getAccountInfo', [address, {'encoding': 'base64'}]))['value'];
    if (v == null || v['owner'] != token2022) return BigInt.zero;
    final d = base64.decode((v['data'] as List).first as String);
    if (d.length < 72 || b58encode(d.sublist(0, 32)) != mint) return BigInt.zero;
    var n = BigInt.zero;
    for (var i = 71; i >= 64; i--) {
      n = (n << 8) | BigInt.from(d[i]);
    }
    return n;
  }

  Future<int> solBalance(String address) async => (await _call('getBalance', [address]))['value'] as int;

  /// Lamports an account of [bytes] needs to be rent-exempt on this network.
  Future<int> rentExempt(int bytes) async => await _call('getMinimumBalanceForRentExemption', [bytes]) as int;

  Future<String> send(String base64Tx) async => await _call('sendTransaction', [
        base64Tx,
        {'encoding': 'base64', 'preflightCommitment': 'confirmed'},
      ]) as String;

  /// Polls until [sig] is confirmed. Throws if it failed on chain or never lands.
  Future<void> confirm(String sig, {Duration timeout = const Duration(seconds: 60)}) async {
    final end = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(end)) {
      final r = await _call('getSignatureStatuses', [[sig]]);
      final s = (r['value'] as List).first;
      if (s != null) {
        if (s['err'] != null) throw ChainError('Transaction failed: ${jsonEncode(s['err'])}');
        final st = s['confirmationStatus'];
        if (st == 'confirmed' || st == 'finalized') return;
      }
      await Future.delayed(const Duration(milliseconds: 800));
    }
    throw ChainError('Not confirmed within ${timeout.inSeconds}s: $sig');
  }

  Future<List<Sig>> history(List<String> accounts, {int limit = 20}) async {
    final out = <Sig>[];
    for (final a in accounts) {
      final r = await _call('getSignaturesForAddress', [a, {'limit': limit}]) as List;
      for (final s in r) {
        out.add(Sig(
          s['signature'] as String,
          s['blockTime'] == null ? null : DateTime.fromMillisecondsSinceEpoch((s['blockTime'] as int) * 1000),
          s['err'] != null,
          s['confirmationStatus'] as String? ?? 'processed',
        ));
      }
    }
    out.sort((a, b) => (b.time ?? DateTime.now()).compareTo(a.time ?? DateTime.now()));
    return out.take(limit).toList();
  }
}

class Sig {
  final String signature;
  final DateTime? time;
  final bool failed;
  final String status;
  const Sig(this.signature, this.time, this.failed, this.status);
}

class ChainError implements Exception {
  final String message;
  ChainError(this.message);
  @override
  String toString() => message;
}

/// "1284000.5" style formatting of base units with thousands separators.
String fmtUnits(BigInt units) {
  final div = BigInt.from(10).pow(Chain.decimals);
  final whole = fmtInt((units ~/ div).toString());
  final frac = (units % div).toString().padLeft(Chain.decimals, '0').replaceAll(RegExp(r'0+$'), '');
  return frac.isEmpty ? whole : '$whole.$frac';
}

String fmtInt(String s) {
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}
