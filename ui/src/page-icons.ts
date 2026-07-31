export const PAGE_ICONS = [
  "✦", "✨", "📝", "🌿", "💡", "📚", "☀️", "🎯",
  "🪄", "📄", "📌", "🗂️", "✅", "📅", "🚀", "💬",
  "🔖", "🧭", "🧠", "🎨", "💻", "📊", "🏠", "❤️",
  "⭐",
] as const;

export function isPageIcon(value: unknown): value is (typeof PAGE_ICONS)[number] {
  return typeof value === "string" && PAGE_ICONS.includes(value as (typeof PAGE_ICONS)[number]);
}
