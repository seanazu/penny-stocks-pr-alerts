export const isoNow = () => new Date().toISOString();
export const minutesAgoISO = (m: number) => new Date(Date.now() - m*60_000).toISOString();
