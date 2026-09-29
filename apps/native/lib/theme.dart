import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Design tokens. Same values as design/APP-DESIGN-SPEC.md and the pen.dev variables.
class Tok {
  final Color bg, surface, line, text, muted, accent, ink, blue, ok, warn, danger;
  const Tok({
    required this.bg,
    required this.surface,
    required this.line,
    required this.text,
    required this.muted,
    required this.accent,
    required this.ink,
    required this.blue,
    required this.ok,
    required this.warn,
    required this.danger,
  });

  static const dark = Tok(
    bg: Color(0xFF0B1020),
    surface: Color(0xFF121933),
    line: Color(0xFF232C4D),
    text: Color(0xFFE8ECF7),
    muted: Color(0xFF8A93B2),
    accent: Color(0xFF2EE6D6),
    ink: Color(0xFF04121A),
    blue: Color(0xFF5B8CFF),
    ok: Color(0xFF3DD68C),
    warn: Color(0xFFF5B94A),
    danger: Color(0xFFFF6B6B),
  );

  static const light = Tok(
    bg: Color(0xFFFAFAF7),
    surface: Color(0xFFFFFFFF),
    line: Color(0xFFDDDDD3),
    text: Color(0xFF111526),
    muted: Color(0xFF5C6480),
    accent: Color(0xFF0FA89B),
    ink: Color(0xFFFFFFFF),
    blue: Color(0xFF3B6BE0),
    ok: Color(0xFF1F9D63),
    warn: Color(0xFFB7791F),
    danger: Color(0xFFD64545),
  );

  static Tok of(BuildContext c) =>
      Theme.of(c).brightness == Brightness.dark ? dark : light;
}

ThemeData buildTheme(Brightness b) {
  final t = b == Brightness.dark ? Tok.dark : Tok.light;
  final base = ThemeData(brightness: b, useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: t.bg,
    colorScheme: ColorScheme.fromSeed(
      seedColor: t.accent,
      brightness: b,
      surface: t.bg,
      primary: t.accent,
      onPrimary: t.ink,
      error: t.danger,
    ),
    textTheme: GoogleFonts.ibmPlexSansTextTheme(base.textTheme)
        .apply(bodyColor: t.text, displayColor: t.text),
    dividerColor: t.line,
    splashFactory: NoSplash.splashFactory,
  );
}

TextStyle mono(BuildContext c, {double size = 14, FontWeight w = FontWeight.w500, Color? color}) =>
    GoogleFonts.ibmPlexMono(fontSize: size, fontWeight: w, color: color ?? Tok.of(c).text);
