/** Minimal typed event emitter shared by the host-side core objects. */
export type Disposable = { dispose(): void };

type AnyListener = (value: never) => void;

/** Event maps with `void` payloads are emitted without an argument. */
type EmitArgs<T> = [T] extends [void] ? [] : [value: T];

export class Emitter<Events extends object> {
	private readonly listeners = new Map<keyof Events, Set<AnyListener>>();

	on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): Disposable {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener as AnyListener);
		return {
			dispose: () => {
				this.listeners.get(event)?.delete(listener as AnyListener);
			},
		};
	}

	emit<K extends keyof Events>(event: K, ...args: EmitArgs<Events[K]>): void {
		const set = this.listeners.get(event);
		if (!set) return;
		const value = args[0] as never;
		for (const listener of [...set]) listener(value);
	}

	clear(): void {
		this.listeners.clear();
	}
}
