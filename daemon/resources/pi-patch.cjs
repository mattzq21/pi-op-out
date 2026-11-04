function ownerName(target) {
  if (typeof target === 'function') return target.name || 'class';

  return target?.constructor?.name || 'object';
}

function missing(owner, name, kind) {
  return new Error(`Pi has no ${kind} ${owner}.${name}, which piop uses. Update piop's Pi changes for this Pi version.`);
}

function requireMethods(target, names, owner = ownerName(target)) {
  for (const name of names) if (typeof target?.[name] !== 'function') throw missing(owner, name, 'method');
}

function patchMethod(target, name, replace, owner = ownerName(target)) {
  requireMethods(target, [name], owner);
  const original = target[name];
  const replacement = replace(original);

  if (typeof replacement !== 'function') throw new Error(`Piop's replacement of ${owner}.${name} is not a function`);
  target[name] = replacement;

  return original;
}

function patchGetter(target, name, replace, owner = ownerName(target)) {
  let descriptor;

  for (let object = target; object && !descriptor; object = Object.getPrototypeOf(object)) descriptor = Object.getOwnPropertyDescriptor(object, name);

  if (typeof descriptor?.get !== 'function') throw missing(owner, name, 'property');
  const replacement = replace(descriptor.get);

  if (typeof replacement !== 'function') throw new Error(`Piop's replacement of ${owner}.${name} is not a function`);
  Object.defineProperty(target, name, { configurable: true, get: replacement });
}

module.exports = { patchMethod, patchGetter, requireMethods };
