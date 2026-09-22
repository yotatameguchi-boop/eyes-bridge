import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, MIN_TAP, space, type as typeScale } from "../theme";

type Props = {
  label: string;
  hint?: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** 画面いっぱいに広げる。手探りで押す前提の主要操作に使う。 */
  hero?: boolean;
};

export function BigButton({
  label,
  hint,
  onPress,
  variant = "primary",
  disabled = false,
  hero = false,
}: Props) {
  const palette = {
    primary: { bg: colors.primary, fg: colors.onPrimary },
    secondary: { bg: colors.surface, fg: colors.text },
    danger: { bg: colors.danger, fg: colors.onPrimary },
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.base,
        hero && styles.hero,
        {
          backgroundColor: palette.bg,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
          borderColor: variant === "secondary" ? colors.border : "transparent",
        },
      ]}
    >
      <View style={styles.inner}>
        <Text
          style={[styles.label, { color: palette.fg, fontSize: hero ? typeScale.hero : typeScale.body }]}
          maxFontSizeMultiplier={2.5}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TAP,
    borderRadius: 16,
    borderWidth: 2,
    justifyContent: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  hero: { flex: 1, borderRadius: 24 },
  inner: { alignItems: "center", justifyContent: "center" },
  label: { fontWeight: "700", textAlign: "center" },
});
