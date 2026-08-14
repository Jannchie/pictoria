"""The AI model stack. **This file must not import any submodule.**

Every handler imports lazily -- `from ai.<module> import ...` inside the function,
always tagged `# noqa: PLC0415  # lazy: defer the ML stack` -- so that a model's
load cost is only paid when that model is actually used. But importing
`ai.anything` runs this file first, so a single re-export here defeats all of it.

This used to hold `from .make_captions import OpenAIImageAnnotator`. Measured cost
of that one line:

    import ai                       14.4 s
    make_captions alone              9.5 s   (diffusers 7.1 s + openai 1.0 s)
    from ai.silva_scorer import ... 11.2 s   vs torch alone 2.9 s

So every process paid ~9.5 s and a few hundred MB of RSS on its **first** GPU task
to load diffusers and openai -- for captioning, a feature that may never be used,
and one `handlers.py` had already deferred to its call site.

To expose a symbol, import it from the submodule directly
(`from ai.make_captions import OpenAIImageAnnotator`).
"""
