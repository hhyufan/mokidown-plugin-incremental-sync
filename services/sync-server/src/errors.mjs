export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export function requireValue(condition, message) {
  if (!condition) throw new ApiError(400, 'INVALID_REQUEST', message);
}
