import { describe, expect, it } from "vitest";
import { blanksIn, firstBlank, rewriteDeal } from "./rewrite-deal";

const rw = (condition: string, suggested_rewrite: string | null) => ({ condition, suggested_rewrite });

// The deal and the drafter's real refusal from the QA run (docs/qa-report.md, DEF-02).
const YOGA = "Pay Sam $200 for a website for my yoga studio by next Friday. It must look professional and modern, and the code must be clean.";
const YOGA_REFUSAL = [
  rw(
    "a website for my yoga studio",
    'The page at [your public URL] responds with a 2xx status and its main heading contains the text "[your yoga studio name]".',
  ),
  rw("it must look professional and modern", "The page at [your public URL] has no sideways scrolling at 375 pixels wide."),
  rw("the code must be clean", "The page at [your public URL] responds with a 2xx status."),
];

// README "Try it in five minutes", step 2, with the refusal sentence added.
const README_DEAL =
  "Pay $20 for a one-page website, due in 3 days. It must load at a public URL, work at phone width (375px) without scrolling sideways, and explain that the domain is for use in documentation examples.";

describe("rewriteDeal: the cases reproduced in the QA report", () => {
  it("keeps a deliverable that is the object of the sentence and adds the rewrite after it (QA case 1)", () => {
    expect(rewriteDeal(YOGA, YOGA_REFUSAL[0])).toBe(
      "Pay Sam $200 for a website for my yoga studio by next Friday. " +
        'The page at [your public URL] responds with a 2xx status and its main heading contains the text "[your yoga studio name]". ' +
        "It must look professional and modern, and the code must be clean.",
    );
  });

  it('takes out a clause joined by ", and" without leaving ". ." (QA case 2)', () => {
    expect(rewriteDeal(YOGA, YOGA_REFUSAL[2])).toBe(
      "Pay Sam $200 for a website for my yoga studio by next Friday. It must look professional and modern. " +
        "The page at [your public URL] responds with a 2xx status.",
    );
  });

  it('drops "It must also look professional." whole instead of leaving "It must also." (QA case 3)', () => {
    expect(
      rewriteDeal(`${README_DEAL} It must also look professional.`, rw("look professional", "The page has no sideways scrolling at 375 pixels wide.")),
    ).toBe(`${README_DEAL} The page has no sideways scrolling at 375 pixels wide.`);
  });

  it("applies the three rewrites of the real refusal in turn and leaves well-formed sentences", () => {
    let deal = YOGA;
    const steps = YOGA_REFUSAL.map((v) => (deal = rewriteDeal(deal, v)));
    expect(steps[1]).toBe(
      "Pay Sam $200 for a website for my yoga studio by next Friday. " +
        'The page at [your public URL] responds with a 2xx status and its main heading contains the text "[your yoga studio name]". ' +
        "The code must be clean. The page at [your public URL] has no sideways scrolling at 375 pixels wide.",
    );
    expect(deal).toBe(
      "Pay Sam $200 for a website for my yoga studio by next Friday. " +
        'The page at [your public URL] responds with a 2xx status and its main heading contains the text "[your yoga studio name]". ' +
        "The page at [your public URL] responds with a 2xx status. " +
        "The page at [your public URL] has no sideways scrolling at 375 pixels wide.",
    );
    expect(deal).not.toMatch(/\.\s*\.|\bmust\s*\.|\bfor\s+by\b/);
  });

  it("handles the README demo sentence, whether the drafter quotes it with its lead-in or not", () => {
    const deal = `${README_DEAL} It must also look professional.`;
    const rewrite = "The submitted page has no sideways scrolling at 375 pixels wide.";
    expect(rewriteDeal(deal, rw("It must also look professional.", rewrite))).toBe(`${README_DEAL} ${rewrite}`);
    expect(rewriteDeal(deal, rw("look professional", null))).toBe(README_DEAL);
  });
});

describe("rewriteDeal: taking the vague wording out", () => {
  it("removes the last item of a list and moves the conjunction", () => {
    expect(
      rewriteDeal(
        "Pay $250 for a landing page that loads at a public URL, works at phone width, and looks beautiful.",
        rw("looks beautiful", 'The submitted page\'s main heading contains the text "Rosa\'s Bakery".'),
      ),
    ).toBe(
      "Pay $250 for a landing page that loads at a public URL and works at phone width. " +
        'The submitted page\'s main heading contains the text "Rosa\'s Bakery".',
    );
  });

  it("removes a middle item, and the first item, of a list", () => {
    expect(rewriteDeal(README_DEAL, rw("work at phone width (375px) without scrolling sideways", null))).toBe(
      "Pay $20 for a one-page website, due in 3 days. It must load at a public URL and explain that the domain is for use in documentation examples.",
    );
    expect(rewriteDeal(README_DEAL, rw("load at a public URL", null))).toBe(
      "Pay $20 for a one-page website, due in 3 days. It must work at phone width (375px) without scrolling sideways and explain that the domain is for use in documentation examples.",
    );
  });

  it("keeps quoted text with commas and full stops intact", () => {
    expect(
      rewriteDeal(
        'Pay Sam $400 for a landing page for my bakery, Crumb & Co., due in 3 days. It must have "Crumb & Co." in its main heading, look modern, and show the text "Open daily, 7am".',
        rw("look modern", null),
      ),
    ).toBe(
      'Pay Sam $400 for a landing page for my bakery, Crumb & Co., due in 3 days. It must have "Crumb & Co." in its main heading and show the text "Open daily, 7am".',
    );
  });

  it("relinks a list of clauses", () => {
    expect(
      rewriteDeal(
        "Pay $100 for issue #31 in octo/notes. The PR must be merged, CI must be green, and the UI should feel intuitive.",
        rw("the UI should feel intuitive", null),
      ),
    ).toBe("Pay $100 for issue #31 in octo/notes. The PR must be merged and CI must be green.");
  });

  it("removes a relative clause or an adjective and keeps the terms around it", () => {
    expect(rewriteDeal("Pay $200 for a website that looks professional, due Friday.", rw("looks professional", null))).toBe(
      "Pay $200 for a website, due Friday.",
    );
    expect(
      rewriteDeal("Pay 500 USD for a high-quality, user-friendly online store, delivered by December 1.", rw("high-quality, user-friendly", null)),
    ).toBe("Pay 500 USD for an online store, delivered by December 1.");
    expect(rewriteDeal("I need a fast website with good SEO. $150, done by Friday.", rw("good SEO", null))).toBe(
      "I need a fast website. $150, done by Friday.",
    );
  });

  it("takes a lone word joined by 'and' with the phrase", () => {
    expect(rewriteDeal("Pay $40 for a site. It must look professional and modern.", rw("look professional", "The submitted page has a form."))).toBe(
      "Pay $40 for a site. The submitted page has a form.",
    );
  });

  it("drops a sentence it cannot cut cleanly unless it states an amount or a deadline", () => {
    expect(rewriteDeal("Pay $40 for a site. It must look nice to visitors.", rw("look nice", "The submitted page has a form."))).toBe(
      "Pay $40 for a site. The submitted page has a form.",
    );
    expect(rewriteDeal("Pay Bob $50 to make me a website.", rw("make me a website", "The submitted page responds with a 2xx status."))).toBe(
      "Pay Bob $50 to make me a website. The submitted page responds with a 2xx status.",
    );
  });
});

describe("rewriteDeal: adding the rewrite", () => {
  it("appends the rewrite when the wording is not in the deal, ending the deal's last sentence first", () => {
    expect(rewriteDeal("Pay $40 for a site", rw("looks slick", "the submitted page has a form"))).toBe(
      "Pay $40 for a site. The submitted page has a form.",
    );
  });

  it("does not add a rewrite the deal already has", () => {
    const deal = "Pay $40 for a site. The submitted page has a form. It must look nice.";
    expect(rewriteDeal(deal, rw("look nice", "The submitted page has a form."))).toBe("Pay $40 for a site. The submitted page has a form.");
  });

  it("finds the wording whatever its case, spacing and apostrophe style", () => {
    expect(rewriteDeal("Pay $40 for a site. It must  LOOK   like Rosa’s brand.", rw("look like Rosa's brand", null))).toBe("Pay $40 for a site.");
  });
});

describe("blanks", () => {
  it("lists the bracketed blanks of a rewrite, not CSS attribute selectors", () => {
    expect(blanksIn('The page shows "[your studio name]" and input[type=email] accepts [an email address].')).toEqual([
      "[your studio name]",
      "[an email address]",
    ]);
    expect(blanksIn(null)).toEqual([]);
  });

  it("finds only the blanks a rewrite inserted, never brackets the payer typed (DEF-01)", () => {
    const typed = 'Its <h1> heading must say "Crumb & Co." and the footer must read [beta].';
    expect(firstBlank(typed, [])).toBeNull();
    expect(firstBlank(typed, ["[your studio name]"])).toBeNull();
    const deal = `${typed} The main heading contains "[your studio name]". It shows [your opening hours].`;
    expect(firstBlank(deal, ["[your opening hours]", "[your studio name]"])).toEqual({
      text: "[your studio name]",
      index: deal.indexOf("[your studio name]"),
    });
  });
});

describe("rewriteDeal: the drafter splitting one sentence into several conditions", () => {
  it("handles 'look professional', 'modern' and 'the code must be clean' in any order, with no rewrite", () => {
    const parts = [rw("look professional", null), rw("modern", null), rw("the code must be clean", null)];
    const apply = (order: number[]) => order.reduce((deal, i) => rewriteDeal(deal, parts[i]), YOGA);
    expect(rewriteDeal(YOGA, parts[0])).toBe("Pay Sam $200 for a website for my yoga studio by next Friday. The code must be clean.");
    expect(rewriteDeal(YOGA, parts[1])).toBe(
      "Pay Sam $200 for a website for my yoga studio by next Friday. It must look professional, and the code must be clean.",
    );
    for (const order of [[0, 1, 2], [1, 0, 2], [2, 1, 0], [1, 2, 0]]) {
      expect(apply(order)).toBe("Pay Sam $200 for a website for my yoga studio by next Friday.");
    }
  });
});
