export * from './constants';
export * from './vehicles';
export * from './cosmetics';
export * from './track';
export * from './physics';
export * from './progress';
export * from './validation';
export * from './protocol';

export function damageState(health: number): 'healthy' | 'damaged' | 'critical' | 'destroyed' {
  if (health <= 0) return 'destroyed';
  if (health < 35) return 'critical';
  if (health < 75) return 'damaged';
  return 'healthy';
}
export * from './autopilot';
