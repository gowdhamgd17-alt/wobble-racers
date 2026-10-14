// Cosmetic options. Nothing here affects vehicle stats.

export const BODY_COLORS: { id: string; label: string; hex: string }[] = [
  { id: 'red', label: 'Red', hex: '#ef3e36' },
  { id: 'blue', label: 'Blue', hex: '#2f6fed' },
  { id: 'yellow', label: 'Yellow', hex: '#ffd23f' },
  { id: 'green', label: 'Green', hex: '#3bb273' },
  { id: 'orange', label: 'Orange', hex: '#ff8c32' },
  { id: 'purple', label: 'Purple', hex: '#8e5cf7' },
  { id: 'pink', label: 'Pink', hex: '#ff6fb5' },
  { id: 'cyan', label: 'Cyan', hex: '#2ad4e0' },
  { id: 'black', label: 'Black', hex: '#24252b' },
  { id: 'white', label: 'White', hex: '#f4f4f0' },
  { id: 'lime', label: 'Lime', hex: '#a6e22e' },
  { id: 'teal', label: 'Teal', hex: '#178f8f' },
];

export const WHEEL_STYLES: { id: string; label: string }[] = [
  { id: 'classic', label: 'Classic' },
  { id: 'chunky', label: 'Chunky' },
  { id: 'spoke', label: 'Star Spoke' },
];

export type CharacterId = 'bonk' | 'moo' | 'zip' | 'pepper' | 'rex' | 'luna' | 'gramps' | 'pip';

export const CHARACTERS: {
  id: CharacterId;
  name: string;
  personality: string;
  palette: [string, string, string];
}[] = [
  {
    id: 'bonk',
    name: 'Professor Bonk',
    personality: 'Absent-minded genius. Keeps adjusting his huge glasses mid-crash.',
    palette: ['#f2d0a9', '#ffffff', '#3d3d55'],
  },
  {
    id: 'moo',
    name: 'Moolissa',
    personality: 'A very competitive cow. Laughs loudly after every overtake.',
    palette: ['#ffffff', '#2b2b2b', '#ff9fb2'],
  },
  {
    id: 'zip',
    name: 'Zip-9',
    personality: 'Tiny anxious robot. Panics the moment its wheels leave the ground.',
    palette: ['#9fb4c7', '#ffcc00', '#36c9ff'],
  },
  {
    id: 'pepper',
    name: 'Pepper Pomodoro',
    personality: 'Dramatic chef. Waves a ladle at everyone she passes.',
    palette: ['#c9784f', '#ffffff', '#e63946'],
  },
  {
    id: 'rex',
    name: 'Rexford',
    personality: 'Tiny-armed dinosaur. Cannot reach the steering wheel, races anyway.',
    palette: ['#5cbf5a', '#f5d76e', '#2e7d32'],
  },
  {
    id: 'luna',
    name: 'Luna Vega',
    personality: 'Astronaut on shore leave. Treats every jump like a moon landing.',
    palette: ['#f0f0f5', '#ff7a45', '#7fd6ff'],
  },
  {
    id: 'gramps',
    name: 'Grandpa Gus',
    personality: 'Has driven since cars had cranks. Shakes his fist at anyone who passes.',
    palette: ['#f1c9a5', '#8d6e63', '#e0e0e0'],
  },
  {
    id: 'pip',
    name: 'Pip',
    personality: 'Small penguin, enormous ego. Flaps with joy at every overtake.',
    palette: ['#23263a', '#ffffff', '#ffa726'],
  },
];

export const CHARACTER_IDS = CHARACTERS.map((c) => c.id);
export const COLOR_IDS = BODY_COLORS.map((c) => c.id);
export const WHEEL_STYLE_IDS = WHEEL_STYLES.map((w) => w.id);

export function colorHex(id: string): string {
  return BODY_COLORS.find((c) => c.id === id)?.hex ?? '#ef3e36';
}

export function characterInfo(id: string) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}
