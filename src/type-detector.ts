import { ServerAPI } from '@signalk/server-api';

/** Data type of a Signal K path, used to drive the operator/value UI. */
export interface PathTypeInfo {
  dataType: 'numeric' | 'angular' | 'boolean' | 'string' | 'position' | 'enum' | 'unknown';
  unit?: string;
  enumValues?: string[];
  description?: string;
}

const ANGULAR_UNITS = ['rad'];
const NUMERIC_UNITS = ['m', 'm/s', 'knots', 'V', 'A', 'Hz', 'K', 'Pa', 'kg', 'J', 'ratio', 'deg', 'C', '%'];

const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === 'string' ? (o[k] as string) : undefined;
const arr = (o: Record<string, unknown>, k: string): string[] | undefined =>
  Array.isArray(o[k]) ? (o[k] as string[]) : undefined;

/**
 * Detect a path's data type from its Signal K metadata (units / enum / type),
 * falling back to sampling the current value. Mirrors signalk-parquet's
 * type-detector so the rules UI offers the right operators and value inputs.
 */
export function detectPathType(path: string, app: ServerAPI): PathTypeInfo {
  // Any path ending in 'position' is a lat/lon position.
  if (path.endsWith('position')) {
    return { dataType: 'position', description: 'Geographic position (latitude/longitude)' };
  }

  const metadata = app.getMetadata(path) as Record<string, unknown> | undefined;

  if (metadata) {
    const unit = str(metadata, 'units');
    if (unit) {
      if (ANGULAR_UNITS.includes(unit)) {
        return { dataType: 'angular', unit, description: str(metadata, 'description') };
      }
      // Known or unknown unit → treat as numeric (units imply a number).
      return { dataType: 'numeric', unit, description: str(metadata, 'description') };
    }
    const enumValues = arr(metadata, 'enum') || arr(metadata, 'values');
    if (enumValues && enumValues.length > 0) {
      return { dataType: 'enum', enumValues, description: str(metadata, 'description') };
    }
    const type = str(metadata, 'type');
    const description = str(metadata, 'description');
    if (type === 'boolean' || description?.toLowerCase().includes('boolean')) {
      return { dataType: 'boolean', description };
    }
  }

  // Fall back to sampling the live value.
  const node = app.getSelfPath(path);
  const value =
    node && typeof node === 'object' && 'value' in node
      ? (node as { value: unknown }).value
      : node;
  if (typeof value === 'boolean') return { dataType: 'boolean' };
  if (typeof value === 'number') return { dataType: 'numeric' };
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number') {
      return { dataType: 'position' };
    }
  }
  if (typeof value === 'string') return { dataType: 'string' };
  return { dataType: 'unknown' };
}
