// 测试用的 JSON Schema 校验（2020-12 的子集）。不引入依赖（FE-600）：只实现 protocol/schema 用到的关键字，
// 遇到没实现的关键字直接报错，不会静默放过（Schema 增加新关键字时测试会提醒这里跟进）。
type Json = unknown;
type Schema = Record<string, Json> | boolean;

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  '$defs',
  'endpoints',
  'default',
  'examples',
]);

export class SchemaValidator {
  constructor(private readonly root: Record<string, Json>) {}

  /** 返回错误列表，空表示通过。ref 例如 #/$defs/AuthResponse；不给时校验根。 */
  errors(value: Json, ref?: string): string[] {
    const out: string[] = [];
    this.check(ref ? this.resolve(ref) : this.root, value, '$', out);
    return out;
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith('#')) throw new Error(`unsupported $ref ${ref}`);
    let cur: Json = this.root;
    for (const part of ref.slice(1).split('/').filter(Boolean)) {
      cur = (cur as Record<string, Json>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (cur === undefined) throw new Error(`unresolved $ref ${ref}`);
    }
    return cur as Schema;
  }

  private check(schema: Schema, v: Json, at: string, out: string[]): void {
    if (schema === true) return;
    if (schema === false) {
      out.push(`${at}: schema is false`);
      return;
    }
    const obj = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : null;
    for (const [k, arg] of Object.entries(schema)) {
      if (ANNOTATIONS.has(k) || k === 'then' || k === 'else') continue;
      switch (k) {
        case '$ref':
          this.check(this.resolve(arg as string), v, at, out);
          break;
        case 'type': {
          const types = Array.isArray(arg) ? (arg as string[]) : [arg as string];
          if (!types.some((t) => isType(t, v))) out.push(`${at}: not ${types.join('|')}`);
          break;
        }
        case 'const':
          if (JSON.stringify(arg) !== JSON.stringify(v)) out.push(`${at}: not const ${JSON.stringify(arg)}`);
          break;
        case 'enum':
          if (!(arg as Json[]).some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${at}: not in enum`);
          break;
        case 'minimum':
          if (typeof v === 'number' && v < (arg as number)) out.push(`${at}: < ${String(arg)}`);
          break;
        case 'maximum':
          if (typeof v === 'number' && v > (arg as number)) out.push(`${at}: > ${String(arg)}`);
          break;
        case 'minLength':
          if (typeof v === 'string' && [...v].length < (arg as number)) out.push(`${at}: too short`);
          break;
        case 'maxLength':
          if (typeof v === 'string' && [...v].length > (arg as number)) out.push(`${at}: too long`);
          break;
        case 'pattern':
          if (typeof v === 'string' && !regex(arg as string).test(v)) out.push(`${at}: pattern ${String(arg)}`);
          break;
        case 'minItems':
          if (Array.isArray(v) && v.length < (arg as number)) out.push(`${at}: too few items`);
          break;
        case 'maxItems':
          if (Array.isArray(v) && v.length > (arg as number)) out.push(`${at}: too many items`);
          break;
        case 'items':
          if (Array.isArray(v)) v.forEach((x, i) => this.check(arg as Schema, x, `${at}[${i}]`, out));
          break;
        case 'required':
          if (obj) for (const r of arg as string[]) if (!(r in obj)) out.push(`${at}: missing ${r}`);
          break;
        case 'minProperties':
          if (obj && Object.keys(obj).length < (arg as number)) out.push(`${at}: too few properties`);
          break;
        case 'maxProperties':
          if (obj && Object.keys(obj).length > (arg as number)) out.push(`${at}: too many properties`);
          break;
        case 'properties':
          if (obj) {
            for (const [p, s] of Object.entries(arg as Record<string, Schema>)) {
              if (p in obj) this.check(s, obj[p], `${at}.${p}`, out);
            }
          }
          break;
        case 'propertyNames':
          if (obj) for (const p of Object.keys(obj)) this.check(arg as Schema, p, `${at}{${p}}`, out);
          break;
        case 'additionalProperties':
          if (obj) {
            const known = (schema['properties'] ?? {}) as Record<string, Json>;
            for (const p of Object.keys(obj)) {
              if (!(p in known)) this.check(arg as Schema, obj[p], `${at}.${p}`, out);
            }
          }
          break;
        case 'allOf':
          for (const s of arg as Schema[]) this.check(s, v, at, out);
          break;
        case 'anyOf':
          if (!(arg as Schema[]).some((s) => this.passes(s, v))) out.push(`${at}: no anyOf matched`);
          break;
        case 'oneOf': {
          const n = (arg as Schema[]).filter((s) => this.passes(s, v)).length;
          if (n !== 1) out.push(`${at}: oneOf matched ${n}`);
          break;
        }
        case 'not':
          if (this.passes(arg as Schema, v)) out.push(`${at}: matched not`);
          break;
        case 'if': {
          const branch = this.passes(arg as Schema, v) ? schema['then'] : schema['else'];
          if (branch !== undefined) this.check(branch as Schema, v, at, out);
          break;
        }
        default:
          throw new Error(`json-schema: keyword ${k} is not implemented (at ${at})`);
      }
    }
  }

  private passes(schema: Schema, v: Json): boolean {
    const out: string[] = [];
    this.check(schema, v, '$', out);
    return out.length === 0;
  }
}

function isType(t: string, v: Json): boolean {
  switch (t) {
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    default:
      return typeof v === t;
  }
}

const cache = new Map<string, RegExp>();
function regex(p: string): RegExp {
  let r = cache.get(p);
  if (!r) {
    r = new RegExp(p, 'u');
    cache.set(p, r);
  }
  return r;
}
