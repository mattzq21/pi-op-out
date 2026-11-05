
type Method = (...args: any[]) => any;

function ownerName(target) {
  if (typeof target === 'function') return target.name || 'class';

  return target?.constructor?.name || 'object';
}

function missing(owner, name, kind) {
  return new Error(`Pi has no ${kind} ${owner}.${name}, which piop uses. Update piop's Pi changes for this Pi version.`);
}

function requireMethods(target: any, names: string[], owner: string = ownerName(target)): void {
  for (const name of names) if (typeof target?.[name] !== 'function') throw missing(owner, name, 'method');
}

function patchMethod<T extends Method>(target: any, name: string, replace: (original: T) => Method, owner: string = ownerName(target)): T {
  requireMethods(target, [name], owner);
  const original = target[name];
  const replacement = replace(original);

  if (typeof replacement !== 'function') throw new Error(`Piop's replacement of ${owner}.${name} is not a function`);
  target[name] = replacement;

  return original;
}

function patchGetter(target: unknown, name: string, replace: (original: () => unknown) => () => unknown, owner: string = ownerName(target)): void {
  let descriptor;

  for (let object = target; object && !descriptor; object = Object.getPrototypeOf(object)) descriptor = Object.getOwnPropertyDescriptor(object, name);

  if (typeof descriptor?.get !== 'function') throw missing(owner, name, 'property');
  const replacement = replace(descriptor.get);

  if (typeof replacement !== 'function') throw new Error(`Piop's replacement of ${owner}.${name} is not a function`);
  Object.defineProperty(target, name, { configurable: true, get: replacement });
}

export { patchMethod, patchGetter, requireMethods };
