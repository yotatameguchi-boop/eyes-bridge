// 弱視の人が前提。色数は絞り、コントラストは WCAG AAA (7:1) を狙う。
// 色だけで意味を伝えない（必ず文言かアイコン形状を併記する）。
export const colors = {
  bg: "#000000",
  surface: "#1A1A1A",
  border: "#5C5C5C",
  text: "#FFFFFF",
  textMuted: "#C7C7C7",
  primary: "#FFD400",     // 黒地に黄色。低視力でも最も見つけやすい組み合わせ
  onPrimary: "#000000",
  danger: "#FF6B6B",
  ok: "#7BE495",
};

export const type = {
  // 端末の文字サイズ設定に追従させるので、ここは下限値
  hero: 44,
  title: 30,
  body: 22,
  caption: 18,
};

export const space = { xs: 8, sm: 12, md: 20, lg: 32, xl: 48 };

/** タップ領域の下限。Apple/Google の推奨は 44/48dp だが、
 *  手探りで押すことを考えて大きめに取る。 */
export const MIN_TAP = 64;
