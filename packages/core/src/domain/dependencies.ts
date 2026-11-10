/**
 * Returns a dependency path that would form a cycle if `taskId` depended on `dependsOn`, or null.
 *
 * @param graph existing edges: task id → ids it depends on (excluding `taskId`'s current edges,
 *              which are being replaced)
 */
export function findDependencyCycle(
  taskId: string,
  dependsOn: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  for (const start of dependsOn) {
    const path = findPath(start, taskId, graph);
    if (path) return [taskId, ...path];
  }
  return null;
}

/** Iterative DFS for a path `from` → `to` following dependency edges. */
function findPath(
  from: string,
  to: string,
  graph: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const stack: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node === to) return path;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!visited.has(next)) stack.push({ node: next, path: [...path, next] });
    }
  }
  return null;
}
