/* The fictional catalogue. Every title, artist and play count is invented.
   The numbers below (bpm, scale, prog, ...) are the "score" synth.js plays. */
window.UMUSIC_TRACKS = [
  { id: 't1',  title: 'Warehouse 9',          artist: 'DJ Quillfeather', genre: 'house',     plays: 2418330, tags: ['dance', 'club'],            hue: 12,  style: 'house',     bpm: 122, bars: 16, root: 45, scale: 'minor',    prog: [0, 5, 3, 4],    seed: 101 },
  { id: 't2',  title: 'Night Bus to Nowhere', artist: 'Static Violet',   genre: 'synthwave', plays: 1873204, tags: ['retro', 'night drive'],     hue: 290, style: 'synthwave', bpm: 104, bars: 12, root: 45, scale: 'minor',    prog: [0, 5, 2, 6],    seed: 202 },
  { id: 't3',  title: 'Pixel Picnic',         artist: 'Bitwise Bears',   genre: 'chiptune',  plays: 1522981, tags: ['8-bit', 'happy'],           hue: 135, style: 'chiptune',  bpm: 144, bars: 16, root: 60, scale: 'major',    prog: [0, 4, 5, 3],    seed: 303 },
  { id: 't4',  title: 'Soft Static',          artist: 'Tape Hiss Club',  genre: 'lofi',      plays: 1190457, tags: ['chill', 'study'],           hue: 35,  style: 'lofi',      bpm: 76,  bars: 8,  root: 57, scale: 'dorian',   prog: [1, 4, 0, 3],    seed: 404 },
  { id: 't5',  title: 'Paper Lanterns',       artist: 'Mossgrove',       genre: 'ambient',   plays: 987612,  tags: ['calm', 'instrumental'],     hue: 185, style: 'ambient',   bpm: 60,  bars: 8,  root: 50, scale: 'dorian',   prog: [0, 3, 5, 4],    seed: 505 },
  { id: 't6',  title: 'Forklift Disco',       artist: 'DJ Quillfeather', genre: 'house',     plays: 864019,  tags: ['dance', 'funny'],           hue: 50,  style: 'house',     bpm: 126, bars: 16, root: 48, scale: 'dorian',   prog: [0, 0, 3, 4],    seed: 606 },
  { id: 't7',  title: 'Level Up Lullaby',     artist: 'Bitwise Bears',   genre: 'chiptune',  plays: 733508,  tags: ['8-bit', 'calm'],            hue: 215, style: 'chiptune',  bpm: 120, bars: 16, root: 62, scale: 'pentatonic', prog: [0, 2, 3, 1],  seed: 707 },
  { id: 't8',  title: 'Rainy Window Study',   artist: 'Tape Hiss Club',  genre: 'lofi',      plays: 641870,  tags: ['chill', 'study', 'rain'],   hue: 225, style: 'lofi',      bpm: 70,  bars: 8,  root: 55, scale: 'minor',    prog: [0, 5, 2, 4],    seed: 808 },
  { id: 't9',  title: 'Neon Parking Lot',     artist: 'Static Violet',   genre: 'synthwave', plays: 512344,  tags: ['retro', 'driving'],         hue: 325, style: 'synthwave', bpm: 112, bars: 14, root: 47, scale: 'minor',    prog: [0, 2, 5, 4],    seed: 909 },
  { id: 't10', title: 'Glass Tide',           artist: 'Mossgrove',       genre: 'ambient',   plays: 402761,  tags: ['calm', 'instrumental', 'sleep'], hue: 165, style: 'ambient', bpm: 54, bars: 8, root: 52, scale: 'major',  prog: [0, 4, 3, 5],    seed: 1010 },
  { id: 't11', title: 'Kettle Moon',          artist: 'Pale Orchard',    genre: 'lofi',      plays: 288105,  tags: ['chill', 'cozy'],            hue: 265, style: 'lofi',      bpm: 82,  bars: 8,  root: 53, scale: 'major',    prog: [0, 3, 1, 4],    seed: 1111 },
  { id: 't12', title: 'Slow Weather',         artist: 'Sundial Echo',    genre: 'ambient',   plays: 154890,  tags: ['sleep', 'instrumental'],    hue: 100, style: 'ambient',   bpm: 48,  bars: 6,  root: 48, scale: 'pentatonic', prog: [0, 2, 1],     seed: 1212 }
];
window.UMUSIC_GENRES = ['ambient', 'chiptune', 'house', 'lofi', 'synthwave'];
