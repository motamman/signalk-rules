import { Engine } from 'json-rules-engine';

/** A geographic position as Signal K reports it. */
interface LatLon {
  latitude: number;
  longitude: number;
}
/** The compare-to value for radius operators: a centre + radius in metres. */
interface RadiusValue extends LatLon {
  radius: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lon points, in metres (haversine). */
function haversineMetres(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function isLatLon(v: unknown): v is LatLon {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as LatLon).latitude === 'number' &&
    typeof (v as LatLon).longitude === 'number'
  );
}
function isRadiusValue(v: unknown): v is RadiusValue {
  return isLatLon(v) && typeof (v as RadiusValue).radius === 'number';
}

/**
 * Register the custom geospatial operators on an Engine. `withinRadius` /
 * `outsideRadius` compare a position fact against a `{latitude, longitude,
 * radius}` value (radius in metres). The built-in operators (greaterThan,
 * lessThan, equal, contains, in, …) are always available without registration.
 */
export function registerCustomOperators(engine: Engine): void {
  // Boolean convenience operators (value is ignored — the operator says it all).
  engine.addOperator('isTrue', (factValue: unknown) => factValue === true);
  engine.addOperator('isFalse', (factValue: unknown) => factValue === false);

  engine.addOperator('withinRadius', (factValue: unknown, compareTo: unknown) => {
    if (!isLatLon(factValue) || !isRadiusValue(compareTo)) return false;
    return haversineMetres(factValue, compareTo) <= compareTo.radius;
  });
  engine.addOperator('outsideRadius', (factValue: unknown, compareTo: unknown) => {
    if (!isLatLon(factValue) || !isRadiusValue(compareTo)) return false;
    return haversineMetres(factValue, compareTo) > compareTo.radius;
  });
}

/**
 * The operator catalogue offered to the UI per detected data type. The webapp
 * uses this to populate the operator dropdown so a user never types syntax.
 * `value` describes the input shape the UI should render.
 */
export const OPERATORS_BY_TYPE: Record<
  string,
  Array<{ op: string; label: string; value: 'number' | 'text' | 'none' | 'range' | 'radius' }>
> = {
  numeric: [
    { op: 'greaterThan', label: 'is greater than', value: 'number' },
    { op: 'greaterThanInclusive', label: 'is ≥', value: 'number' },
    { op: 'lessThan', label: 'is less than', value: 'number' },
    { op: 'lessThanInclusive', label: 'is ≤', value: 'number' },
    { op: 'equal', label: 'equals', value: 'number' },
    { op: 'notEqual', label: 'does not equal', value: 'number' },
  ],
  angular: [
    { op: 'greaterThan', label: 'is greater than', value: 'number' },
    { op: 'lessThan', label: 'is less than', value: 'number' },
    { op: 'equal', label: 'equals', value: 'number' },
    { op: 'notEqual', label: 'does not equal', value: 'number' },
  ],
  boolean: [
    { op: 'isTrue', label: 'is true', value: 'none' },
    { op: 'isFalse', label: 'is false', value: 'none' },
  ],
  string: [
    { op: 'equal', label: 'equals', value: 'text' },
    { op: 'notEqual', label: 'does not equal', value: 'text' },
    { op: 'contains', label: 'contains', value: 'text' },
    { op: 'doesNotContain', label: 'does not contain', value: 'text' },
  ],
  enum: [
    { op: 'equal', label: 'equals', value: 'text' },
    { op: 'notEqual', label: 'does not equal', value: 'text' },
  ],
  position: [
    { op: 'withinRadius', label: 'is within radius of', value: 'radius' },
    { op: 'outsideRadius', label: 'is outside radius of', value: 'radius' },
  ],
  unknown: [
    { op: 'equal', label: 'equals', value: 'text' },
    { op: 'notEqual', label: 'does not equal', value: 'text' },
    { op: 'greaterThan', label: 'is greater than', value: 'number' },
    { op: 'lessThan', label: 'is less than', value: 'number' },
  ],
};
