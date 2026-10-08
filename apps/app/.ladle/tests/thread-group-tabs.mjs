const page = await browser.getPage("main");
const origin = new URL(page.url()).origin;
const STORIES = ["pinned-loading", "several-pinned", "long-pinned-label"];
const EPSILON = 0.5;

for (const story of STORIES) {
  await page.goto(
    `${origin}/?story=thread--thread-group-tabs--${story}&mode=preview`,
  );
  await page.waitForSelector('[data-thread-group-tabs] [role="tab"]');
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 390, 768]) {
    await page.setViewport({
      width,
      height: 740,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const geometry = await page.evaluate(() => {
      const strip = document.querySelector("[data-thread-group-tabs]");
      const tablist = strip?.querySelector('[role="tablist"]');
      const [pinned, scroller] = tablist?.children ?? [];
      if (!strip || !tablist || !pinned || !scroller) {
        throw new Error("Missing pinned or scrolling tabs");
      }
      const rect = (element) => element.getBoundingClientRect().toJSON();
      const gap = Number.parseFloat(getComputedStyle(tablist).columnGap) || 0;
      return {
        strip: rect(strip),
        tablist: rect(tablist),
        pinned: rect(pinned),
        scroller: rect(scroller),
        scrollerContentWidth: scroller.scrollWidth,
        evenShare: (tablist.getBoundingClientRect().width - gap) / 2,
        create: strip.querySelector("[data-thread-group-create]")
          ? rect(strip.querySelector("[data-thread-group-create]"))
          : null,
        tabs: [...pinned.querySelectorAll('[role="tab"]')].map((tab) => ({
          label: tab.getAttribute("title"),
          rect: rect(tab),
          parts: [...tab.children]
            .filter(
              (part) =>
                getComputedStyle(part).position !== "absolute" &&
                part.getBoundingClientRect().width > 0,
            )
            .map((part) => ({
              name: part.getAttribute("class") ?? part.tagName,
              rect: rect(part),
            })),
        })),
      };
    });
    console.log(JSON.stringify({ story, width, ...geometry }));
    const where = `${story} at ${width}px`;
    if (geometry.pinned.right > geometry.scroller.left + EPSILON) {
      throw new Error(`${where}: pinned tabs overlap the scrolling tabs`);
    }
    if (geometry.tablist.right > geometry.strip.right + EPSILON) {
      throw new Error(`${where}: tabs overflow the header`);
    }
    if (
      geometry.create &&
      geometry.tablist.right > geometry.create.left + EPSILON
    ) {
      throw new Error(`${where}: tabs overlap the create button`);
    }
    if (
      geometry.scroller.width + EPSILON <
      Math.min(geometry.scrollerContentWidth, geometry.evenShare)
    ) {
      throw new Error(
        `${where}: pinned tabs take more than their share from discussions`,
      );
    }
    for (const tab of geometry.tabs) {
      if (tab.rect.width <= 0) {
        throw new Error(`${where}: pinned tab collapsed: ${tab.label}`);
      }
      if (tab.rect.right > geometry.pinned.right + EPSILON) {
        throw new Error(
          `${where}: pinned tab overflows its track: ${tab.label}`,
        );
      }
      for (const part of tab.parts) {
        if (
          part.rect.left < tab.rect.left - EPSILON ||
          part.rect.right > tab.rect.right + EPSILON
        ) {
          throw new Error(
            `${where}: ${part.name} overflows pinned tab ${tab.label}`,
          );
        }
      }
    }
  }
}
console.log(
  "PASS: pinned tabs and their contents stay inside their share of the strip",
);
