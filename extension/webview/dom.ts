/**
 * The three element helpers both webviews build DOM with.
 *
 * Shared because there are now two entry points (`main.ts` for the sidebar,
 * `settings.ts` for the settings page) that draw in the same plain-DOM style;
 * keeping one copy means `el`/`button`/`svgIcon` cannot drift apart between them.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
	const node = el("button", className, label);
	node.addEventListener("click", onClick);
	return node;
}

/**
 * One inline glyph on a 16×16 viewBox. Icons are paths rather than a font because the
 * webview's CSP loads no external font, and a handful of shapes is not worth bundling
 * VS Code's codicon font for. Colour comes from CSS (`stroke: currentColor`).
 */
export function svgIcon(paths: readonly string[], className: string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", className);
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	for (const d of paths) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}
