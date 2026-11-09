// The substances the ground, water and air are made of, and what they are like. Everything the model does with heat (how much it takes to warm a layer, how fast it is carried through one,
// how much sunlight a surface keeps, how much heat melting or evaporating takes) comes from these, not from numbers chosen for each use.
//   rho kg/m3, c J/kg/K, k W/m/K (conductivity), albedo (the share of sunlight reflected), emissivity (against a black body at the same temperature).
export const SUBSTANCES = {
  air: { rho: 1.2, c: 1005, k: 0.026 },                                       // near the ground
  water: { rho: 1000, c: 4180, k: 0.57, albedo: 0.06, emissivity: 0.96 },
  ice: { rho: 917, c: 2100, k: 2.2, albedo: 0.4, emissivity: 0.97 },
  soil: { rho: 1500, c: 800, k: 1.0, albedo: 0.2, emissivity: 0.97 },         // dry bulk density, moist loam conductivity, grass over it
};
/** Snow: ice and air, so what it is like follows from its density. New snow is about 100 kg/m3 and settles toward `settled` (a seasonal pack is 300 to 450); its albedo falls from `albedoNew` to `albedoOld` as it settles
 *  and darkens (aged snow in forest clearings is about 0.7 to 0.8), and it takes `compactDays` at freezing to settle most of the way (quicker when warm). */
export const SNOW = { rhoNew: 100, rhoSettled: 450, albedoNew: 0.85, albedoOld: 0.75, compactDays: 25 };
/** Heat to melt a kg of ice and to evaporate a kg of water, J/kg. */
export const LATENT = { fusion: 3.34e5, vaporization: 2.5e6 };
/** Constants of nature: the sunlight at the top of the air (W/m2), Stefan-Boltzmann (W/m2/K4), the psychrometric constant (kPa/K). */
export const NATURE = { solar: 1361, sigma: 5.670374e-8, psychrometric: 0.066 };
/** Snow is ice and air; what it is like follows from how dense it is. Its conductivity (Calonne and others, 2011), W/m/K, for a density in kg/m3. */
export const snowConductivity = (rho) => 2.5e-6 * rho * rho - 1.23e-4 * rho + 0.024;
/** Heat capacity per volume, J/m3/K, of a substance. */
export const volumetricHeat = (s) => s.rho * s.c;
