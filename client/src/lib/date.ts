export const APP_TIME_ZONE = "Asia/Riyadh"

function parseServerDate(value: string): Date {
  if (!value) return new Date(NaN)
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z"
  return new Date(normalized)
}

export function formatSaudiDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  const date = parseServerDate(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: APP_TIME_ZONE, dateStyle: "short", timeStyle: "medium",
  }).format(date)
}

export function formatSaudiTime(value: string | null | undefined): string {
  if (!value) return "—"
  const date = parseServerDate(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date)
}
