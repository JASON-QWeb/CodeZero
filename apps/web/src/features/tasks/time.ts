export function formatTime(value: string): string {
  const date = new Date(value);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()] ?? "Jan";
  return `${month} ${pad2(date.getUTCDate())}, ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
