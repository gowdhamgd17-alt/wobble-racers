export * from './constants';
export * from './vehicles';
export * from './cosmetics';
export * from './track';
export * from './physics';
export * from './progress';
export * from './validation';
export * from './protocol';
export * from './weapons';
export * from './arena';
export * from './sim';

export function damageState(health: number, maxHealth = 100): 'healthy' | 'damaged' | 'critical' | 'destroyed' {
  if (health <= 0) return 'destroyed';
  const r = health / (maxHealth || 100);
  if (r < 0.35) return 'critical';
  if (r < 0.75) return 'damaged';
  return 'healthy';
}
export * from './autopilot';
