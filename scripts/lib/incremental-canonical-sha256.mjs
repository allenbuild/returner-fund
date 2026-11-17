import { createHash } from "node:crypto";

/** Hash the experiment serializer's exact tokens without retaining its full output. */
export function incrementalCanonicalSha256(value) {
  const digest = createHash("sha256");
  let tokens = [];
  let characters = 0;
  const flush = () => {
    if (tokens.length) digest.update(tokens.join(""));
    tokens = [];
    characters = 0;
  };
  const emit = (token) => {
    tokens.push(token);
    characters += token.length;
    if (characters >= 64 * 1024 || tokens.length >= 8192) flush();
  };
  const visit = (item, position) => {
    if (Array.isArray(item)) {
      emit("[");
      const length = item.length;
      for (let index = 0; index < length; index += 1) {
        if (index) emit(",");
        if (index in item) visit(item[index], "array");
      }
      emit("]");
    } else if (item && typeof item === "object") {
      emit("{");
      const keys = Object.keys(item).sort((left, right) => left.localeCompare(right, "en"));
      for (let index = 0; index < keys.length; index += 1) {
        if (index) emit(",");
        emit(JSON.stringify(keys[index]));
        emit(":");
        visit(item[keys[index]], "object");
      }
      emit("}");
    } else {
      const serialized = JSON.stringify(item);
      if (serialized !== undefined) emit(serialized);
      else if (position === "object") emit("undefined");
      else if (position !== "array") digest.update(serialized);
    }
  };
  visit(value, "root");
  flush();
  return digest.digest("hex");
}
