// Procedural, smooth-shaded models. Everything is generated in code, so there
// are no external model files to load or license.
export { buildCharacter, type CharacterRig } from './characters';
export { CharacterAnimator, type AnimInput } from './animator';
export { buildCar, disposeCar, makeNameTag, setCarGun, type CarParts } from './cars';
export { buildGun, type GunModel } from './guns';
export { setModelDetail, getModelDetail, environmentFor } from './kit';
