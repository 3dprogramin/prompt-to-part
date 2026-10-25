// The note shown over the 3D view (an export's check, a failed save, a design deleted elsewhere).
export type Notice = { text: string; level: 'ok' | 'error' | 'warning' | 'info'; details: boolean };
