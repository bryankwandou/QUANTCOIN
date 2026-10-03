import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:local_auth/local_auth.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'chain.dart';
import 'data.dart';
import 'keystore.dart';
import 'l10n.dart';
import 'send.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Draw behind status bar, notch / Dynamic Island / punch-hole and the nav bar;
  // every screen then pads itself with SafeArea so nothing is covered.
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    systemNavigationBarColor: Colors.transparent,
    systemNavigationBarContrastEnforced: false,
  ));
  final prefs = await SharedPreferences.getInstance();
  runApp(QuantumSafe(prefs: prefs));
}

/// mobile_scanner has no Windows/Linux implementation: there the scan button is
/// hidden and the address is pasted or typed instead.
bool get scanSupported => kIsWeb || const {
      TargetPlatform.android, TargetPlatform.iOS, TargetPlatform.macOS,
    }.contains(defaultTargetPlatform);

/// Fingerprint / face / device PIN before a send. Null when there is no OS
/// authenticator (web, or a device without a screen lock): the caller then asks
/// for the app passcode again. Replaceable in tests.
Future<bool?> Function(String reason) deviceAuth = (reason) async {
  if (kIsWeb) return null;
  final auth = LocalAuthentication();
  if (!await auth.isDeviceSupported()) return null;
  return auth.authenticate(localizedReason: reason);
};

class AppState extends ChangeNotifier {
  AppState(this.prefs)
      : mode = ThemeMode.values[prefs.getInt('theme') ?? 0],
        lang = prefs.getString('lang') ?? 'en',
        // Release builds only ever talk to mainnet; devnet is for debug builds.
        network = kReleaseMode ? 'mainnet' : prefs.getString('network') ?? 'mainnet',
        vault = prefs.getString('vault');
  final SharedPreferences prefs;
  ThemeMode mode;
  String lang, network;
  String? vault;
  bool unlocked = false;

  // Chain state, filled by refresh().
  BigInt? balance;
  List<Sig> sigs = [];
  bool loading = false;
  String? error;

  void setMode(ThemeMode m) { mode = m; prefs.setInt('theme', m.index); notifyListeners(); }
  void setLang(String l) { lang = l; prefs.setString('lang', l); notifyListeners(); }
  void unlock() { unlocked = true; notifyListeners(); refresh(); }
  void lock() { unlocked = false; notifyListeners(); }

  // Passcode is stored only as sha256(salt + code).
  bool get hasCode => prefs.getString('codeHash') != null;
  String _hash(String salt, String code) => sha256.convert(utf8.encode(salt + code)).toString();
  // Five wrong codes in a row lock the keypad: 30 s, doubling per further miss, at most an hour.
  // On a device without biometrics the passcode is the only gate before a send.
  Duration get codeLock {
    final ms = (prefs.getInt('codeLockUntil') ?? 0) - DateTime.now().millisecondsSinceEpoch;
    return ms > 0 ? Duration(milliseconds: ms) : Duration.zero;
  }

  bool checkCode(String code) {
    if (codeLock > Duration.zero) return false;
    if (_hash(prefs.getString('codeSalt')!, code) == prefs.getString('codeHash')) {
      prefs.remove('codeFails');
      return true;
    }
    final fails = (prefs.getInt('codeFails') ?? 0) + 1;
    prefs.setInt('codeFails', fails);
    if (fails >= 5) {
      final secs = min(30 << min(fails - 5, 7), 3600);
      prefs.setInt('codeLockUntil', DateTime.now().millisecondsSinceEpoch + secs * 1000);
    }
    return false;
  }
  void setCode(String code) {
    final r = Random.secure();
    final salt = base64Url.encode(List.generate(16, (_) => r.nextInt(256)));
    prefs.setString('codeSalt', salt);
    prefs.setString('codeHash', _hash(salt, code));
  }

  void setVault(String? v) {
    vault = v;
    v == null ? prefs.remove('vault') : prefs.setString('vault', v);
    balance = null;
    sigs = [];
    notifyListeners();
    refresh();
  }

  void setNetwork(String n) { network = n; prefs.setString('network', n); setVault(vault); }

  String? get rpc => prefs.getString('rpc');
  void setRpc(String u) { u.trim().isEmpty ? prefs.remove('rpc') : prefs.setString('rpc', u.trim()); setVault(vault); }

  String explorer(String sig) =>
      'https://explorer.solana.com/tx/$sig${network == 'mainnet' ? '' : '?cluster=$network'}';

  Future<void> refresh() async {
    final v = vault;
    if (v == null || loading) return;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final ch = Chain(network, rpc: rpc);
      final accts = await ch.tokenAccounts(v);
      balance = await ch.balance(accts);
      sigs = await ch.history(accts);
    } catch (e) {
      error = '$e';
    }
    loading = false;
    notifyListeners();
  }
  String t(String k, {int? n}) => tr(lang, k, n: n);
}

class Scope extends InheritedNotifier<AppState> {
  const Scope({super.key, required AppState state, required super.child}) : super(notifier: state);
  static AppState of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<Scope>()!.notifier!;
}

class QuantumSafe extends StatefulWidget {
  const QuantumSafe({super.key, required this.prefs});
  final SharedPreferences prefs;
  @override
  State<QuantumSafe> createState() => _QuantumSafeState();
}

class _QuantumSafeState extends State<QuantumSafe> {
  late final state = AppState(widget.prefs);
  @override
  Widget build(BuildContext context) => Scope(
        state: state,
        child: ListenableBuilder(
          listenable: state,
          builder: (c, _) => MaterialApp(
            title: 'Quantum Safe',
            debugShowCheckedModeBanner: false,
            theme: buildTheme(Brightness.light),
            darkTheme: buildTheme(Brightness.dark),
            themeMode: state.mode,
            builder: (c, child) => Directionality(
              textDirection: rtlLangs.contains(state.lang) ? TextDirection.rtl : TextDirection.ltr,
              child: child!,
            ),
            home: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              child: state.unlocked ? const Shell() : const UnlockScreen(),
            ),
          ),
        ),
      );
}

// ───────────────────────── shared pieces

class Btn extends StatelessWidget {
  const Btn(this.label, {super.key, this.onTap, this.icon, this.ghost = false, this.danger = false});
  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool ghost, danger;
  @override
  Widget build(BuildContext c) {
    final t = Tok.of(c);
    final bg = ghost ? Colors.transparent : (danger ? t.danger : t.accent);
    final fg = ghost ? t.text : (danger ? Colors.white : t.ink);
    return Opacity(
      opacity: onTap == null ? .35 : 1,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: ghost ? BorderSide(color: t.line) : BorderSide.none,
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap == null ? null : () { HapticFeedback.lightImpact(); onTap!(); },
          child: SizedBox(
            height: 48,
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (icon != null) ...[Icon(icon, size: 16, color: fg), const SizedBox(width: 8)],
              Flexible(child: Text(label, overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: fg, fontWeight: FontWeight.w600))),
            ]),
          ),
        ),
      ),
    );
  }
}

class Coin extends StatelessWidget {
  const Coin({super.key, this.size = 40});
  final double size;
  @override
  Widget build(BuildContext c) {
    final t = Tok.of(c);
    return Container(
      width: size, height: size,
      decoration: BoxDecoration(color: t.accent, shape: BoxShape.circle),
      alignment: Alignment.center,
      child: Container(
        width: size * .8, height: size * .8,
        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: t.ink, width: size / 28 < 1 ? 1 : size / 28)),
        alignment: Alignment.center,
        child: Text('QC', style: mono(c, size: size * .3, w: FontWeight.w700, color: t.ink)),
      ),
    );
  }
}

// ───────────────────────── unlock

class UnlockScreen extends StatefulWidget {
  const UnlockScreen({super.key});
  @override
  State<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends State<UnlockScreen> with SingleTickerProviderStateMixin {
  String entered = '';
  String? first; // setup: the passcode typed the first time
  bool wrong = false;
  late final shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 360));

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bio());
  }

  @override
  void dispose() { shake.dispose(); super.dispose(); }

  Future<void> _bio() async {
    if (kIsWeb || !Scope.of(context).hasCode) return;
    final auth = LocalAuthentication();
    try {
      if (!await auth.isDeviceSupported()) return;
      final ok = await auth.authenticate(localizedReason: 'Open your vaults', biometricOnly: true);
      if (ok && mounted) Scope.of(context).unlock();
    } catch (_) {/* fall back to passcode */}
  }

  void _key(String k) {
    HapticFeedback.selectionClick();
    setState(() {
      wrong = false;
      if (k == '<') {
        if (entered.isNotEmpty) entered = entered.substring(0, entered.length - 1);
      } else if (entered.length < 6) {
        entered += k;
      }
    });
    if (entered.length == 6) {
      final s = Scope.of(context);
      if (!s.hasCode) {
        if (first == null) {
          setState(() { first = entered; entered = ''; });
        } else if (first == entered) {
          s.setCode(entered);
          HapticFeedback.mediumImpact();
          s.unlock();
        } else {
          HapticFeedback.heavyImpact();
          shake.forward(from: 0);
          setState(() { wrong = true; first = null; entered = ''; });
        }
      } else if (s.checkCode(entered)) {
        HapticFeedback.mediumImpact();
        s.unlock();
      } else {
        HapticFeedback.heavyImpact();
        shake.forward(from: 0);
        setState(() { wrong = true; entered = ''; });
      }
    }
  }

  @override
  Widget build(BuildContext c) {
    final t = Tok.of(c), s = Scope.of(c);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(children: [
                const Spacer(),
                const Coin(size: 56),
                const SizedBox(height: 16),
                Text(wrong
                        ? (s.codeLock > Duration.zero
                            ? '${s.t('wrong')} · ${s.t('tryIn', n: s.codeLock.inSeconds + 1)}'
                            : s.t(s.hasCode ? 'wrong' : 'mismatch'))
                        : s.t(s.hasCode ? 'unlock' : (first == null ? 'setCode' : 'confirmCode')),
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: wrong ? t.danger : t.text)),
                const SizedBox(height: 20),
                AnimatedBuilder(
                  animation: shake,
                  builder: (c, child) => Transform.translate(
                    offset: Offset(6 * (1 - shake.value) * ((shake.value * 6).floor().isEven ? 1 : -1) * (shake.isAnimating ? 1 : 0), 0),
                    child: child,
                  ),
                  child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    for (var i = 0; i < 6; i++)
                      AnimatedContainer(
                        duration: const Duration(milliseconds: 120),
                        margin: const EdgeInsets.symmetric(horizontal: 7),
                        width: 14, height: 14,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: wrong ? t.danger : (i < entered.length ? t.accent : Colors.transparent),
                          border: Border.all(color: wrong ? t.danger : (i < entered.length ? t.accent : t.line), width: 2),
                        ),
                      ),
                  ]),
                ),
                const Spacer(),
                for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['bio', '0', '<']])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(children: [
                      for (final k in row)
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 5),
                            child: Material(
                              color: k == 'bio' ? Colors.transparent : t.surface,
                              borderRadius: BorderRadius.circular(12),
                              child: InkWell(
                                borderRadius: BorderRadius.circular(12),
                                onTap: () => k == 'bio' ? _bio() : _key(k),
                                child: SizedBox(
                                  height: 56,
                                  child: Center(
                                    child: k == '<'
                                        ? Icon(Icons.backspace_outlined, color: t.text, size: 20)
                                        : k == 'bio'
                                            ? Icon(Icons.fingerprint, color: t.accent, size: 26, semanticLabel: s.t('useBio'))
                                            : Text(k, style: mono(c, size: 22)),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                    ]),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────── shell with responsive nav

class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int tab = 0;
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    final w = MediaQuery.sizeOf(c).width;
    final items = [
      (Icons.shield_outlined, 'QC'),
      (Icons.send_outlined, s.t('send')),
      (Icons.history, s.t('activity')),
      (Icons.settings_outlined, s.t('settings')),
    ];
    final pages = [
      HomePage(onSend: () => setState(() => tab = 1)),
      const SendPage(),
      const ActivityPage(),
      const SettingsPage(),
    ];
    final body = AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      child: KeyedSubtree(key: ValueKey(tab), child: pages[tab]),
    );
    if (w < 600) {
      return Scaffold(
        body: SafeArea(bottom: false, child: body),
        bottomNavigationBar: NavigationBar(
          selectedIndex: tab,
          backgroundColor: t.bg,
          indicatorColor: t.accent.withValues(alpha: .18),
          onDestinationSelected: (i) { HapticFeedback.selectionClick(); setState(() => tab = i); },
          destinations: [for (final it in items) NavigationDestination(icon: Icon(it.$1), label: it.$2)],
        ),
      );
    }
    return Scaffold(
      body: SafeArea(
        child: Row(children: [
          NavigationRail(
            extended: w >= 1024,
            backgroundColor: t.bg,
            selectedIndex: tab,
            indicatorColor: t.accent.withValues(alpha: .18),
            leading: Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Coin(size: w >= 1024 ? 36 : 32)),
            onDestinationSelected: (i) => setState(() => tab = i),
            destinations: [for (final it in items) NavigationRailDestination(icon: Icon(it.$1), label: Text(it.$2))],
          ),
          VerticalDivider(width: 1, color: t.line),
          Expanded(child: Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720), child: body))),
        ]),
      ),
    );
  }
}

class Header extends StatelessWidget {
  const Header(this.title, {super.key});
  final String title;
  @override
  Widget build(BuildContext c) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
        child: Row(children: [
          Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        ]),
      );
}

// ───────────────────────── home

class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.onSend});
  final VoidCallback onSend;
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    if (s.vault == null) return const _NoVault();
    return RefreshIndicator(
      onRefresh: s.refresh,
      child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
        const Header('Quantum Safe'),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(s.t('vault'), style: TextStyle(fontSize: 12, color: t.muted)),
            const SizedBox(height: 6),
            if (s.balance == null)
              SizedBox(height: 46, child: s.loading
                  ? Align(alignment: AlignmentDirectional.centerStart, child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: t.accent)))
                  : Text('—', style: mono(c, size: 38)))
            else
              Text.rich(TextSpan(children: [
                TextSpan(text: fmtUnits(s.balance!), style: mono(c, size: 38, w: FontWeight.w600)),
                TextSpan(text: '  QC', style: mono(c, size: 14, color: t.muted)),
              ])),
            Text('${short(s.vault!)} · ${s.network}', style: mono(c, size: 12, color: t.muted)),
            if (s.error != null) _ErrorBox(s.error!),
            const SizedBox(height: 18),
            Row(children: [
              for (final a in [
                (Icons.north_east, s.t('send'), onSend),
                (Icons.south_west, s.t('receive'), () => Navigator.push(c, MaterialPageRoute(builder: (_) => const ReceivePage()))),
              ])
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Material(
                      color: t.surface,
                      borderRadius: BorderRadius.circular(12),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: a.$3,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Column(children: [
                            Icon(a.$1, color: t.accent, size: 20),
                            const SizedBox(height: 6),
                            Text(a.$2, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                          ]),
                        ),
                      ),
                    ),
                  ),
                ),
            ]),
            const SizedBox(height: 20),
            Text(s.t('activity'), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const _SigList(limit: 5),
          ]),
        ),
      ]),
    );
  }
}

class _NoVault extends StatelessWidget {
  const _NoVault();
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Coin(size: 56),
          const SizedBox(height: 16),
          Text(s.t('noVault'), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: t.text)),
          const SizedBox(height: 20),
          SizedBox(width: 260, child: Btn(s.t('addVault'), icon: Icons.add, onTap: () => Navigator.push(c, MaterialPageRoute(builder: (_) => const VaultPage())))),
        ]),
      ),
    );
  }
}

class _ErrorBox extends StatelessWidget {
  const _ErrorBox(this.msg);
  final String msg;
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(border: Border.all(color: t.danger), borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Expanded(child: Text(msg, style: TextStyle(color: t.danger, fontSize: 12))),
        TextButton(onPressed: s.refresh, child: Text(s.t('retry'))),
      ]),
    );
  }
}

class _SigList extends StatelessWidget {
  const _SigList({this.limit});
  final int? limit;
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    final list = limit == null ? s.sigs : s.sigs.take(limit!).toList();
    if (list.isEmpty && !s.loading) {
      return Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Center(child: Text(s.t('noActivity'), style: TextStyle(color: t.muted))));
    }
    return Column(children: [for (final x in list) SigRow(x)]);
  }
}

class SigRow extends StatelessWidget {
  const SigRow(this.x, {super.key});
  final Sig x;
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    final label = x.failed ? 'failed' : x.status;
    final sc = x.failed ? t.danger : label == 'finalized' ? t.ok : t.warn;
    final when = x.time == null ? '' : x.time!.toLocal().toString().substring(0, 16);
    return InkWell(
      onTap: () {
        Clipboard.setData(ClipboardData(text: s.explorer(x.signature)));
        ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(s.explorer(x.signature))));
      },
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.line))),
        child: Row(children: [
          CircleAvatar(radius: 18, backgroundColor: t.surface, child: Icon(Icons.receipt_long, size: 16, color: t.text)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(short(x.signature), style: mono(c, size: 13)),
              Text(when, style: TextStyle(fontSize: 12, color: t.muted)),
            ]),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(border: Border.all(color: sc), borderRadius: BorderRadius.circular(10)),
            child: Text(label, style: mono(c, size: 10, color: sc)),
          ),
        ]),
      ),
    );
  }
}

// ───────────────────────── send

class SendPage extends StatefulWidget {
  const SendPage({super.key});
  @override
  State<SendPage> createState() => _SendPageState();
}

class _SendPageState extends State<SendPage> {
  final addr = TextEditingController();
  AddrCheck check = AddrCheck.empty;

  void _setAddr(String v) => setState(() => check = checkAddress(v));

  Future<void> _scan() async {
    final r = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const ScanPage()));
    if (r != null) {
      final a = r.startsWith('solana:') ? r.substring(7).split('?').first : r;
      addr.text = a;
      _setAddr(a);
    }
  }

  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    String? err;
    switch (check) {
      case AddrCheck.ethereum: err = s.t('ethAddr');
      case AddrCheck.invalid: err = s.t('badAddr');
      case AddrCheck.lookalike: err = s.t('lookalike');
      default: break;
    }
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      Header(s.t('send')),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(s.t('recipient'), style: TextStyle(fontSize: 12, color: t.muted)),
          const SizedBox(height: 6),
          TextField(
            controller: addr,
            onChanged: _setAddr,
            style: mono(c, size: 13),
            decoration: InputDecoration(
              filled: true,
              fillColor: t.surface,
              hintText: 'Solana address',
              suffixIcon: scanSupported ? IconButton(icon: Icon(Icons.qr_code_scanner, color: t.accent), tooltip: s.t('scan'), onPressed: _scan) : null,
              enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: err != null ? t.danger : t.line)),
              focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: err != null ? t.danger : t.accent, width: 2)),
            ),
          ),
          if (err != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(err, style: TextStyle(color: t.danger, fontSize: 12))),
          const SizedBox(height: 16),
          Text(s.t('amount'), style: TextStyle(fontSize: 12, color: t.muted)),
          const SizedBox(height: 6),
          TextField(
            controller: amt,
            onChanged: (_) => setState(() {}),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            style: mono(c, size: 15),
            decoration: InputDecoration(filled: true, fillColor: t.surface, hintText: '0.00000', suffixText: 'QC'),
          ),
          const SizedBox(height: 20),
          ..._signing(c, s, t),
        ]),
      ),
    ]);
  }

  // ── signing
  final amt = TextEditingController();
  KeyStore? _store;
  Keys? _keys;
  int? _feeSol;
  SendStep? _step;
  String? _msg, _done;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final s = Scope.of(context);
    if (_store?.network != s.network) _load(s);
  }

  Future<void> _load(AppState s) async {
    _store = KeyStore(s.network);
    final k = await _store!.load();
    if (!mounted) return;
    setState(() { _keys = k; _feeSol = null; });
    if (k == null) return;
    final ch = Chain(s.network, rpc: s.rpc);
    if (k.pending != null && await _store!.settleIfLanded(k, ch)) await _adopt(s, k);
    try {
      final lam = await ch.solBalance(await k.payer.address());
      if (mounted) setState(() => _feeSol = lam);
    } catch (_) {}
  }

  Future<void> _adopt(AppState s, Keys k) async {
    s.setVault((await k.vault.vault()).$1);
    if (mounted) setState(() => _keys = k);
  }

  Future<void> _create(AppState s) async {
    final k = await _store!.create();
    await _adopt(s, k);
    _load(s);
  }

  Future<void> _import(AppState s) async {
    final txt = TextEditingController();
    final json = await showDialog<String>(context: context, builder: (c) => AlertDialog(
      title: Text(s.t('importKey')),
      content: TextField(controller: txt, maxLines: 6, style: mono(c, size: 11), decoration: const InputDecoration(hintText: '{"owner":[...],"master":"...","seed":"..."}')),
      actions: [TextButton(onPressed: () => Navigator.pop(c, txt.text), child: Text(s.t('save')))],
    ));
    if (json == null || json.trim().isEmpty) return;
    try {
      final k = await _store!.importCli(json);
      await _adopt(s, k);
      _load(s);
    } catch (e) {
      setState(() => _msg = '$e');
    }
  }

  Future<bool> _confirm(AppState s, String to, BigInt amount) async {
    final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
      title: Text(s.t('confirm')),
      content: Text('${fmtUnits(amount)} QC\n→ $to', style: mono(c, size: 13)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: Text(s.t('cancel'))),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(s.t('send'))),
      ],
    ));
    if (ok != true) return false;
    try {
      return await deviceAuth(s.t('confirm')) ?? await _askCode(s);
    } catch (e) {
      // Say why: a silent failure here looks like the Send button is broken.
      if (mounted) setState(() => _msg = '$e');
      return false;
    }
  }

  /// The app passcode, asked again right before a send when there is no
  /// fingerprint/face/device PIN to ask instead. Same lockout as the unlock screen.
  Future<bool> _askCode(AppState s) async {
    if (!s.hasCode) return true;
    final c = TextEditingController();
    final code = await showDialog<String>(context: context, builder: (d) => AlertDialog(
      title: Text(s.t('unlock')),
      content: TextField(
        controller: c, autofocus: true, obscureText: true, maxLength: 6,
        keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        onSubmitted: (v) => Navigator.pop(d, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: Text(s.t('cancel'))),
        FilledButton(onPressed: () => Navigator.pop(d, c.text), child: Text(s.t('confirm'))),
      ],
    ));
    if (code == null) return false;
    if (s.checkCode(code)) return true;
    final wait = s.codeLock;
    if (mounted) {
      setState(() => _msg = wait > Duration.zero ? s.t('tryIn').replaceAll('{n}', '${wait.inSeconds}') : s.t('wrong'));
    }
    return false;
  }

  Future<void> _send(AppState s) async {
    final k = _keys!;
    final p = k.pending;
    final to = p?.recipient ?? addr.text.trim();
    final amount = p?.amount ?? parseUnits(amt.text)!;
    if (!await _confirm(s, to, amount)) return;
    HapticFeedback.mediumImpact();
    setState(() { _msg = null; _done = null; _step = SendStep.preparing; });
    try {
      final sig = await _store!.send(k, Chain(s.network, rpc: s.rpc), to, amount,
          onStep: (st) { if (mounted) setState(() => _step = st); });
      await _adopt(s, k);
      HapticFeedback.heavyImpact();
      if (mounted) setState(() { _done = sig; addr.clear(); amt.clear(); check = AddrCheck.empty; });
    } catch (e) {
      if (mounted) setState(() => _msg = '$e');
      // A confirm timeout, or a resume after the spend already landed (AlreadySpent),
      // still means the funds moved: switch to the next vault right away.
      if (await _store!.settleIfLanded(k, Chain(s.network, rpc: s.rpc))) {
        await _adopt(s, k);
        if (mounted) setState(() => _msg = null);
      }
    }
    if (mounted) setState(() => _step = null);
  }

  List<Widget> _signing(BuildContext c, AppState s, Tok t) {
    final k = _keys;
    Widget note(String m, {Color? color}) => Container(
          padding: const EdgeInsets.all(14),
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: color ?? t.line)),
          child: SelectableText(m, style: TextStyle(color: color ?? t.muted, fontSize: 13)),
        );
    if (k == null) {
      return [
        note(s.t('noKeys')),
        Btn(s.t('createKeys'), icon: Icons.add, onTap: () => _create(s)),
        const SizedBox(height: 10),
        Btn(s.t('importKey'), ghost: true, onTap: () => _import(s)),
        if (_msg != null) Padding(padding: const EdgeInsets.only(top: 12), child: note(_msg!, color: t.danger)),
      ];
    }
    final amount = parseUnits(amt.text);
    final busy = _step != null;
    final pending = k.pending;
    final ready = !busy && (pending != null ||
        (check == AddrCheck.ok && amount != null && amount > BigInt.zero && (s.balance == null || amount <= s.balance!)));
    return [
      FutureBuilder(
        future: k.payer.address(),
        builder: (c, a) => note('${s.t('feeKey')}: ${a.data ?? '…'}\n'
            '${_feeSol == null ? '…' : (_feeSol! / 1e9).toStringAsFixed(4)} SOL'
            '${(_feeSol ?? 1 << 30) < 5000000 ? '\n${s.t('needSol')}' : ''}'),
      ),
      if (pending != null) note('${s.t('unfinished')}: ${fmtUnits(pending.amount)} QC → ${pending.recipient}', color: t.accent),
      if (amount != null && s.balance != null && amount > s.balance!) note(s.t('tooMuch'), color: t.danger),
      Btn(busy ? '${s.t('sending')} · ${s.t('step_${_step!.name}')}' : (pending != null ? s.t('resume') : s.t('review')),
          icon: Icons.send, onTap: ready ? () => _send(s) : null),
      if (busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
      if (_msg != null) Padding(padding: const EdgeInsets.only(top: 12), child: note(_msg!, color: t.danger)),
      if (_done != null) Padding(
        padding: const EdgeInsets.only(top: 12),
        child: note('${s.t('sentOk')}\n$_done\n${s.explorer(_done!)}', color: t.accent),
      ),
    ];
  }
}

class ScanPage extends StatelessWidget {
  const ScanPage({super.key});
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    var done = false;
    return Scaffold(
      appBar: AppBar(title: Text(s.t('scan')), backgroundColor: t.bg),
      body: Stack(children: [
        MobileScanner(
          onDetect: (cap) {
            final v = cap.barcodes.isEmpty ? null : cap.barcodes.first.rawValue;
            if (v != null && !done) {
              done = true;
              HapticFeedback.mediumImpact();
              Navigator.pop(c, v);
            }
          },
          errorBuilder: (c, e) => Center(child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('${s.t('noCamera')}\n${e.errorCode.name}', textAlign: TextAlign.center),
          )),
        ),
        IgnorePointer(
          child: Center(
            child: Container(
              width: 240, height: 240,
              decoration: BoxDecoration(border: Border.all(color: t.accent, width: 3), borderRadius: BorderRadius.circular(20)),
            ),
          ),
        ),
      ]),
    );
  }
}

// ───────────────────────── receive, activity, vault, settings

class ReceivePage extends StatelessWidget {
  const ReceivePage({super.key});
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    final a = s.vault!;
    return Scaffold(
      appBar: AppBar(title: Text(s.t('receive')), backgroundColor: t.bg),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(children: [
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
                child: QrImageView(data: 'solana:$a', size: 220, backgroundColor: Colors.white),
              ),
              const SizedBox(height: 16),
              SelectableText(a, textAlign: TextAlign.center, style: mono(c, size: 13)),
              const SizedBox(height: 16),
              SizedBox(width: 220, child: Btn(s.t('copy'), icon: Icons.copy, onTap: () {
                Clipboard.setData(ClipboardData(text: a));
                ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(s.t('copied'))));
              })),
              const SizedBox(height: 12),
              Text('Send only QC or SOL on Solana (${s.network}).', style: TextStyle(color: t.muted, fontSize: 12)),
            ]),
          ),
        ),
      ),
    );
  }
}

class ActivityPage extends StatelessWidget {
  const ActivityPage({super.key});
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c);
    return RefreshIndicator(
      onRefresh: s.refresh,
      child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
        Header(s.t('activity')),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 20), child: _SigList()),
      ]),
    );
  }
}

class VaultPage extends StatefulWidget {
  const VaultPage({super.key});
  @override
  State<VaultPage> createState() => _VaultPageState();
}

class _VaultPageState extends State<VaultPage> {
  final addr = TextEditingController();
  AddrCheck check = AddrCheck.empty;
  bool _init = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_init) return;
    _init = true;
    addr.text = Scope.of(context).vault ?? '';
    check = checkAddress(addr.text);
  }

  Future<void> _scan() async {
    final r = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const ScanPage()));
    if (r != null) {
      final a = r.startsWith('solana:') ? r.substring(7).split('?').first : r;
      addr.text = a;
      setState(() => check = checkAddress(a));
    }
  }

  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    final bad = check == AddrCheck.ethereum || check == AddrCheck.invalid;
    return Scaffold(
      appBar: AppBar(title: Text(s.t('vaultAddr')), backgroundColor: t.bg),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          TextField(
            controller: addr,
            onChanged: (v) => setState(() => check = checkAddress(v)),
            style: mono(c, size: 13),
            decoration: InputDecoration(
              filled: true,
              fillColor: t.surface,
              hintText: 'Solana address',
              errorText: bad ? s.t(check == AddrCheck.ethereum ? 'ethAddr' : 'badAddr') : null,
              suffixIcon: scanSupported ? IconButton(icon: Icon(Icons.qr_code_scanner, color: t.accent), tooltip: s.t('scan'), onPressed: _scan) : null,
            ),
          ),
          const SizedBox(height: 16),
          Btn(s.t('save'), onTap: check == AddrCheck.ok ? () { s.setVault(addr.text.trim()); Navigator.pop(c); } : null),
          if (s.vault != null) ...[
            const SizedBox(height: 10),
            Btn(s.t('removeVault'), ghost: true, onTap: () { s.setVault(null); Navigator.pop(c); }),
          ],
        ]),
      ),
    );
  }
}

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      Header(s.t('settings')),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(s.t('theme'), style: TextStyle(color: t.muted, fontSize: 12)),
          const SizedBox(height: 8),
          SegmentedButton<ThemeMode>(
            segments: [
              ButtonSegment(value: ThemeMode.system, label: Text(s.t('system'))),
              ButtonSegment(value: ThemeMode.dark, label: Text(s.t('dark'))),
              ButtonSegment(value: ThemeMode.light, label: Text(s.t('light'))),
            ],
            selected: {s.mode},
            onSelectionChanged: (v) => s.setMode(v.first),
          ),
          const SizedBox(height: 20),
          Text(s.t('network'), style: TextStyle(color: t.muted, fontSize: 12)),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            segments: [for (final n in Chain.networks.keys) if (!kReleaseMode || n == 'mainnet') ButtonSegment(value: n, label: Text(n))],
            selected: {s.network},
            onSelectionChanged: (v) => s.setNetwork(v.first),
          ),
          const SizedBox(height: 10),
          TextFormField(
            initialValue: s.rpc ?? '',
            style: mono(c, size: 12),
            keyboardType: TextInputType.url,
            decoration: InputDecoration(
              filled: true,
              fillColor: t.surface,
              labelText: 'RPC URL',
              hintText: Chain.networks[s.network],
            ),
            onFieldSubmitted: s.setRpc,
          ),
          const SizedBox(height: 12),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.account_balance_wallet_outlined, color: t.muted),
            title: Text(s.t('vaultAddr')),
            subtitle: Text(s.vault == null ? '—' : short(s.vault!), style: mono(c, size: 12, color: t.muted)),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(c, MaterialPageRoute(builder: (_) => const VaultPage())),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.translate, color: t.muted),
            title: Text(s.t('language')),
            subtitle: Text(langNames[s.lang] ?? s.lang),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(c, MaterialPageRoute(builder: (_) => const LanguagePage())),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.lock_outline, color: t.muted),
            title: Text(s.t('lock')),
            onTap: s.lock,
          ),
        ]),
      ),
    ]);
  }
}

class LanguagePage extends StatelessWidget {
  const LanguagePage({super.key});
  @override
  Widget build(BuildContext c) {
    final s = Scope.of(c), t = Tok.of(c);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('language')), backgroundColor: t.bg),
      body: SafeArea(
        child: ListView(children: [
          for (final e in langNames.entries)
            ListTile(
              title: Text(e.value),
              subtitle: Text(e.key + (rtlLangs.contains(e.key) ? ' · RTL' : ''), style: mono(c, size: 11, color: t.muted)),
              trailing: s.lang == e.key ? Icon(Icons.check, color: t.accent) : null,
              onTap: () { s.setLang(e.key); Navigator.pop(c); },
            ),
        ]),
      ),
    );
  }
}
