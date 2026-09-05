export class InsufficientPositionError extends Error {
  constructor(positionId: string, available: string, requested: string) {
    super(`Insufficient outcome shares on position ${positionId}: available=${available}, requested=${requested}`);
    this.name = "InsufficientPositionError";
  }
}
