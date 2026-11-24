/** Local VNC target for HQ_LOCAL. Display :99 is port 5999. Never an Orgo URL. */
export function localVncPort(screenId: string | null | undefined): number {
  const display = !screenId || screenId === 'default' ? 99 : Number(String(screenId).replace('screen-', ''));
  if (!Number.isInteger(display) || display < 1 || display > 200) {
    throw new Error(`local screen ${screenId ?? 'default'} has no VNC port`);
  }
  return 5900 + display;
}

export function localVncTarget(screenId: string | null | undefined): { host: '127.0.0.1'; port: number } {
  return { host: '127.0.0.1', port: localVncPort(screenId) };
}
