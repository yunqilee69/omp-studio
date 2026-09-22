import type { MessageImage, PendingPrompt } from "./shared/protocol";

/**
 * Prompts the user submitted while a turn is still running.
 *
 * They live only in the extension until `Instance` actually sends them to omp.
 * Edit and cancel are valid until then; after dispatch they are gone from this list.
 */
export class PendingPrompts {
	private readonly entries: PendingPrompt[] = [];
	private nextId = 0;

	get items(): readonly PendingPrompt[] {
		return this.entries;
	}

	get length(): number {
		return this.entries.length;
	}

	enqueue(text: string, images: readonly MessageImage[] = []): PendingPrompt | undefined {
		const trimmed = text.trim();
		if (!trimmed && images.length === 0) return undefined;
		const entry: PendingPrompt = { id: `p${++this.nextId}`, text: trimmed };
		// Normalized to bytes + type: the queue only ever replays them into a prompt.
		if (images.length > 0) entry.attachments = images.map(({ data, mimeType }) => ({ data, mimeType }));
		this.entries.push(entry);
		return entry;
	}

	update(id: string, text: string): PendingPrompt | undefined {
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (!entry) return undefined;
		const trimmed = text.trim();
		if (!trimmed) {
			this.remove(id);
			return undefined;
		}
		entry.text = trimmed;
		return entry;
	}

	remove(id: string): PendingPrompt | undefined {
		const index = this.entries.findIndex((candidate) => candidate.id === id);
		if (index < 0) return undefined;
		return this.entries.splice(index, 1)[0];
	}

	/** Oldest remaining prompt, or undefined if empty / the id was cancelled. */
	shiftIf(id: string): PendingPrompt | undefined {
		if (this.entries[0]?.id !== id) return undefined;
		return this.entries.shift();
	}

	clear(): PendingPrompt[] {
		return this.entries.splice(0);
	}
}
