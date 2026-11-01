process.env.ORS_API_KEY = '';
const { fallbackRoute, haversineKm } = require('../srv/lib/routing');
const H1 = { lat: 12.9299, long: 77.5826 }, H5 = { lat: 12.9255, long: 77.5468 }, H2 = { lat: 12.9698, long: 77.75 };

test('haversine distance Jayanagar-Banashankari is ~3.9 km', () => {
  expect(haversineKm(H1, H5)).toBeGreaterThan(3.5);
  expect(haversineKm(H1, H5)).toBeLessThan(4.2);
});
test('closure on the path forces a longer detour', () => {
  const direct = fallbackRoute(H2, H1, []);
  const mid = { name: 'Flooded junction', lat: (H1.lat + H2.lat) / 2, long: (H1.long + H2.long) / 2, radiusKm: 1, active: true };
  const det = fallbackRoute(H2, H1, [mid]);
  expect(det.open).toBe(true);
  expect(det.detour).toBe(true);
  expect(det.distanceKm).toBeGreaterThan(direct.distanceKm);
  expect(det.etaMin).toBeGreaterThan(direct.etaMin);
});
test('closure covering an endpoint closes the route', () => {
  expect(fallbackRoute(H2, H1, [{ name: 'x', ...H1, radiusKm: 0.5 }]).open).toBe(false);
});
