"""Brian2 runtime adapter for an explicit, sparse, signed connectome graph."""

from dataclasses import dataclass
import numpy as np


@dataclass
class CircuitGraph:
    neuron_count: int
    pre: np.ndarray
    post: np.ndarray
    weight: np.ndarray  # nonnegative, dimensionless voltage-jump magnitudes
    sign: np.ndarray
    plastic: np.ndarray
    sensory_source: np.ndarray
    sensory_target: np.ndarray
    motor_ids: np.ndarray  # shape (actions, 2, population size): positive / negative
    label: str

    def validate(self, inputs):
        edge_count = len(self.pre)
        if not isinstance(self.label, str) or not self.label:
            raise ValueError("Graph provenance label is required")
        if self.neuron_count < 1 or edge_count < 1:
            raise ValueError("A nonempty sparse graph is required")
        if any(np.asarray(a).shape != (edge_count,) for a in
               [self.pre, self.post, self.weight, self.sign, self.plastic]):
            raise ValueError("Edge arrays must be one-dimensional and equal length")
        if (not np.isfinite(self.weight).all() or np.any(self.weight < 0)
                or np.any(self.weight > 0.5) or not np.isin(self.sign, [-1, 1]).all()
                or not np.isin(self.plastic, [False, True]).all()):
            raise ValueError("Invalid weights, signs, or plastic mask")
        if np.any(np.asarray(self.plastic, dtype=bool) & (self.sign < 0)):
            raise ValueError("This adapter only supports excitatory plasticity")
        for indices, size in [(self.pre, self.neuron_count), (self.post, self.neuron_count),
                              (self.sensory_source, inputs), (self.sensory_target, self.neuron_count),
                              (self.motor_ids, self.neuron_count)]:
            a = np.asarray(indices)
            if a.dtype.kind not in 'iu' or np.any(a < 0) or np.any(a >= size):
                raise ValueError("Graph indices must be integers in range")
        if (self.sensory_source.ndim != 1 or not len(self.sensory_source)
                or self.sensory_source.shape != self.sensory_target.shape):
            raise ValueError("Explicit sensory source/target mapping required")
        if (self.motor_ids.ndim != 3 or self.motor_ids.shape[1] != 2
                or not self.motor_ids.size or len(np.unique(self.motor_ids)) != self.motor_ids.size):
            raise ValueError("Use disjoint opponent motor populations")
    # Summary: This verifies graph topology, physiology assumptions, and interface mappings.
    # Validation precedes simulator construction so malformed data cannot partially build a circuit.
    # Synapse counts are not electrical weights; supplied weights must already be scaled to this model.


def load_graph(path):
    with np.load(path, allow_pickle=False) as data:
        graph = CircuitGraph(int(data['neuron_count']),
                             *[data[k].copy() for k in ['pre', 'post', 'weight', 'sign', 'plastic',
                                                       'sensory_source', 'sensory_target', 'motor_ids']],
                             str(data['label'].item()))
    return graph
# Summary: This loads an explicitly mapped sparse graph from a portable NPZ archive.
# Numeric arrays preserve supplied edges and signs without inventing unobserved connections.
# The label records provenance but does not verify a MaleCNS release or infer transmitter physiology.


def demo_graph(inputs=79, seed=0):
    rng = np.random.default_rng(seed)
    # A small test fixture, explicitly NOT measured MaleCNS wiring.
    sensory_count, hidden_count, motor_count = 24, 32, 8
    hidden_start, motor_start = sensory_count, sensory_count + hidden_count
    pre = np.repeat(np.arange(sensory_count), 4)
    post = rng.integers(hidden_start, motor_start, len(pre))
    plastic_pre = np.repeat(np.arange(hidden_start, motor_start), motor_count)
    plastic_post = np.tile(np.arange(motor_start, motor_start + motor_count), hidden_count)
    count = len(pre)
    return CircuitGraph(motor_start + motor_count, np.r_[pre, plastic_pre], np.r_[post, plastic_post],
                        np.r_[np.full(count, 0.2), rng.uniform(0.05, 0.18, len(plastic_pre))],
                        np.ones(count + len(plastic_pre)),
                        np.r_[np.zeros(count, dtype=bool), np.ones(len(plastic_pre), dtype=bool)],
                        np.arange(inputs), np.arange(inputs) % sensory_count,
                        np.arange(motor_start, motor_start + motor_count).reshape(2, 2, 2),
                        'synthetic-smoke-test-not-MaleCNS')
# Summary: This supplies a reproducible small circuit for testing the complete loop.
# Fixed sensory projections feed a plastic hidden-to-motor layer with opponent actions.
# Successful execution demonstrates software integration, not connectome fidelity or learned DJ skill.


class BrianBrain:
    def __init__(self, graph, inputs=79, dt=0.001, learning_rate=0.02, seed=0):
        import brian2 as b2
        graph.validate(inputs)
        if not np.isfinite([dt, learning_rate]).all() or not 0 < dt <= 0.001 or learning_rate <= 0:
            raise ValueError("Use 0 < dt <= 1 ms and a positive learning rate")
        self.b2, self.graph, self.dt, self.learning_rate = b2, graph, dt, learning_rate
        self.inputs = inputs
        b2.seed(seed)
        clock = b2.Clock(dt=dt * b2.second)
        # NumPy runtime avoids a compiler dependency and allows incremental set_spikes.
        self.neurons = b2.NeuronGroup(graph.neuron_count,
            '''dv/dt = (bias - v) / (20*ms) + noise*xi/(20*ms)**0.5 : 1 (unless refractory)
               bias : 1
               noise : 1''', threshold='v > 1', reset='v = 0', refractory=2*b2.ms,
            method='euler', clock=clock, codeobj_class=b2.NumpyCodeObject)
        self.neurons.bias = 0
        self.neurons.bias[np.unique(graph.motor_ids)] = 0.6
        self.input_group = b2.SpikeGeneratorGroup(inputs, [], []*b2.second, clock=clock,
                                                 codeobj_class=b2.NumpyCodeObject)
        self.projection = b2.Synapses(self.input_group, self.neurons, on_pre='v_post += 0.6',
                                     clock=clock, codeobj_class=b2.NumpyCodeObject)
        self.projection.connect(i=graph.sensory_source, j=graph.sensory_target)
        self.synapses = b2.Synapses(self.neurons, self.neurons,
            '''w : 1
               polarity : 1 (constant)
               plastic : 1 (constant)
               dpre_trace/dt = -pre_trace/(20*ms) : 1 (event-driven)
               dpost_trace/dt = -post_trace/(20*ms) : 1 (event-driven)
               deligibility/dt = -eligibility/(4*second) : 1 (clock-driven)''',
            on_pre='''v_post += polarity*w
                      pre_trace += 0.02
                      eligibility = clip(eligibility + plastic*post_trace, -1, 1)''',
            on_post='''post_trace -= 0.021
                       eligibility = clip(eligibility + plastic*pre_trace, -1, 1)''',
            method='exact', clock=clock, codeobj_class=b2.NumpyCodeObject)
        self.synapses.connect(i=graph.pre, j=graph.post)
        self.synapses.w = graph.weight
        self.synapses.polarity = graph.sign
        self.synapses.plastic = graph.plastic
        self.monitor = b2.SpikeMonitor(self.neurons, record=False,
                                      codeobj_class=b2.NumpyCodeObject)
        self.network = b2.Network(self.neurons, self.input_group, self.projection, self.synapses, self.monitor)
        self.network.store('episode_start')
    # Summary: This constructs a sparse LIF network with explicit sensory and motor mappings.
    # STDP stores bounded eligibility; only a later dopamine impulse changes selected excitatory weights.
    # LIF parameters and projection gains are engineering defaults, not fitted MaleCNS biophysics.

    @property
    def time(self):
        return float(self.network.t / self.b2.second)
    # Summary: This exposes simulator time in the frontend's seconds convention.
    # Unit conversion is kept at the Brian2 boundary.
    # Scheduling against wall-clock time instead would misalign sensory events.

    def reset_state(self):
        weights = np.asarray(self.synapses.w[:]).copy()
        self.network.restore('episode_start', restore_random_state=False)
        self.synapses.w = weights
    # Summary: This clears voltage, spike queues, traces, and counters between episodes.
    # Restoring the pristine network while retaining weights prevents cross-episode credit leakage.
    # The simulator RNG continues; reproduce an experiment by constructing it again with the same seed.

    def act(self, indices, times, duration, exploration):
        if not np.isfinite(exploration) or exploration < 0:
            raise ValueError("Exploration must be finite and nonnegative")
        before = np.asarray(self.monitor.count[:]).copy()
        self.neurons.noise = 0
        self.neurons.noise[np.unique(self.graph.motor_ids)] = exploration
        self.input_group.set_spikes(indices, times*self.b2.second, sorted=True)
        self.network.run(duration*self.b2.second, namespace={})
        counts = (np.asarray(self.monitor.count[:]) - before)[self.graph.motor_ids].mean(axis=2)
        # Two opponent populations encode positive/negative changes, with silence = hold.
        return (counts[:, 0] - counts[:, 1]) / np.maximum(counts.sum(axis=1), 1)
    # Summary: This simulates one sensory window and decodes bounded motor increments.
    # Exploration perturbs motor neurons directly so exploratory spikes participate in eligibility.
    # Counts are read as deltas; a silent population holds its command instead of inventing an action.

    def reinforce(self, dopamine):
        if not np.isfinite(dopamine) or abs(dopamine) > 1:
            raise ValueError("Dopamine must be finite in [-1, 1]")
        mask = np.asarray(self.graph.plastic, dtype=bool)
        weights = np.asarray(self.synapses.w[:]).copy()
        weights[mask] = np.clip(weights[mask] + self.learning_rate * dopamine
                                * np.asarray(self.synapses.eligibility[:])[mask], 0, 0.5)
        self.synapses.w = weights
    # Summary: This applies a single reward-modulated eligibility update.
    # Only explicitly plastic weights move, and fixed signs and bounded magnitudes are preserved.
    # Do not enable a second continuous dopamine rule or the same reward would be applied twice.

    def save(self, path):
        values = {name: getattr(self.graph, name) for name in self.graph.__dataclass_fields__}
        values['weight'] = np.asarray(self.synapses.w[:]).copy()
        np.savez_compressed(path, **values)
    # Summary: This saves learned weights together with graph provenance and interface mappings.
    # The archive can be reloaded through load_graph without losing the original topology.
    # It is an episode-boundary checkpoint, not a mid-simulation snapshot of voltage or RNG state.

# Module summary: This is the executable Brian2 boundary for the Python DJ experiment.
# It preserves supplied sparse wiring and signs while using reward-modulated excitatory STDP.
# No MaleCNS dataset is bundled or silently substituted; full-scale performance remains unmeasured.
