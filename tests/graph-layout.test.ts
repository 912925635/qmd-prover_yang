import assert from 'node:assert/strict';
import test from 'node:test';
import { assignLayers, layoutGraph, transitiveReduction } from '../skills/qmd-prover/src/commands/render/layout.js';
import { graphSvg } from '../skills/qmd-prover/src/commands/render/index.js';
import type { DependencyGraph } from '../skills/qmd-prover/src/core/semantic/dependency-graph.js';

function makeGraph(ids: string[], edges: Array<[string, string]>, cycles: string[][] = []): DependencyGraph {
  return {
    schema_version: 1,
    nodes: ids.map((id) => ({ id, status: 'open' as const, title: id, file: 'goal.qmd', line: 1 })),
    edges: edges.map(([from, to]) => ({ from, to })),
    cycles
  };
}

function rowOf(layout: ReturnType<typeof layoutGraph>, id: string): number {
  const node = layout.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} missing from layout`);
  return node.y;
}

test('a dependency chain stacks into rows with the citing result above its dependency', () => {
  const graph = makeGraph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  const layers = assignLayers(graph);
  assert.equal(layers.get('a'), 0);
  assert.equal(layers.get('b'), 1);
  assert.equal(layers.get('c'), 2);
  const layout = layoutGraph(graph);
  assert.ok(rowOf(layout, 'a') < rowOf(layout, 'b'));
  assert.ok(rowOf(layout, 'b') < rowOf(layout, 'c'));
  for (const edge of layout.edges) {
    assert.equal(edge.back, false);
    for (let index = 1; index < edge.points.length; index += 1) {
      assert.ok(edge.points[index].y > edge.points[index - 1].y, 'edges must descend the page');
    }
  }
});

test('a diamond shares the middle row in id order and every edge points downward', () => {
  const graph = makeGraph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  const layout = layoutGraph(graph);
  assert.equal(rowOf(layout, 'b'), rowOf(layout, 'c'));
  assert.ok(rowOf(layout, 'a') < rowOf(layout, 'b'));
  assert.ok(rowOf(layout, 'c') < rowOf(layout, 'd'));
  const b = layout.nodes.find((node) => node.id === 'b');
  const c = layout.nodes.find((node) => node.id === 'c');
  assert.ok(b && c && b.x < c.x, 'middle row keeps id order');
  assert.equal(layout.edges.length, 4);
  assert.ok(layout.edges.every((edge) => !edge.back));
});

test('a long edge routes through a waypoint and the Hasse view drops it as implied', () => {
  const graph = makeGraph(['a', 'b', 'c'], [['a', 'b'], ['a', 'c'], ['b', 'c']]);
  const reduced = transitiveReduction(graph);
  assert.deepEqual(reduced.map((edge) => `${edge.from}->${edge.to}`), ['a->b', 'b->c']);
  const full = layoutGraph(graph);
  const long = full.edges.find((edge) => edge.from === 'a' && edge.to === 'c');
  assert.ok(long, 'non-Hasse layout keeps the direct edge');
  assert.equal(long.points.length, 3, 'edge spanning two rows gains one waypoint');
  const hasse = layoutGraph(graph, { hasse: true });
  assert.equal(hasse.edges.length, 2);
  assert.ok(!hasse.edges.some((edge) => edge.from === 'a' && edge.to === 'c'));
});

test('barycenter sweeps uncross a two-row crossing', () => {
  const graph = makeGraph(['a1', 'a2', 'b1', 'b2'], [['a1', 'b2'], ['a2', 'b1']]);
  const layout = layoutGraph(graph);
  const x = (id: string): number => layout.nodes.find((node) => node.id === id)?.x ?? 0;
  const crossed = (x('a1') < x('a2')) !== (x('b2') < x('b1'));
  assert.equal(crossed, false, 'edges a1->b2 and a2->b1 must not cross');
});

test('cycles terminate, keep finite rows, and mark exactly one back edge', () => {
  const graph = makeGraph(['x', 'y'], [['x', 'y'], ['y', 'x']], [['x', 'y', 'x']]);
  const layers = assignLayers(graph);
  assert.ok(Number.isFinite(layers.get('x')) && Number.isFinite(layers.get('y')));
  const layout = layoutGraph(graph, { hasse: true });
  assert.equal(layout.edges.length, 2, 'reduction never drops cycle edges');
  assert.equal(layout.edges.filter((edge) => edge.back).length, 1);
});

test('empty and single-node graphs produce finite dimensions and no NaN', () => {
  for (const graph of [makeGraph([], []), makeGraph(['solo'], [])]) {
    const layout = layoutGraph(graph);
    assert.ok(Number.isFinite(layout.width) && layout.width > 0);
    assert.ok(Number.isFinite(layout.height) && layout.height >= 120);
    assert.ok(!JSON.stringify(layout).includes('null'), 'no NaN leaks into the layout');
    assert.ok(graphSvg(graph).startsWith('<svg '));
  }
});

test('identical input yields byte-identical layout and SVG', () => {
  const graph = makeGraph(
    ['goal', 'lem-a', 'lem-b', 'def-x'],
    [['goal', 'lem-a'], ['goal', 'lem-b'], ['lem-a', 'def-x'], ['lem-b', 'def-x'], ['goal', 'def-x']]
  );
  assert.deepEqual(layoutGraph(graph, { hasse: true }), layoutGraph(graph, { hasse: true }));
  assert.equal(graphSvg(graph), graphSvg(graph));
});
