"""Piop dictation worker: streams 16 kHz mono s16le PCM from stdin into a speech model.

Usage: python -c <this script> <engine> <model> <language>
engine is "needle" (Cactus Whistle through the cactus-needle package) or "transcribe.cpp" (the transcribe-cpp package).
language is a language code such as "en", or "" to let the model choose (Needle detects it; transcribe.cpp uses the model default).
Writes one JSON object per line to stdout:
  {"type": "ready", "streaming": bool, "languages": [str], "detect": bool}
                                                             after the model loads; languages the model knows, and whether it can detect one
  {"type": "text", "committed": str, "tentative": str}       when the live text changes
  {"type": "final", "text": str}                             after stdin closes
Errors go to stderr with a non-zero exit code.
"""
import array
import json
import os
import sys

SAMPLE_RATE = 16000


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def chunks(size):
    """Yields float sample arrays of size samples (the last one may be shorter) until stdin closes."""
    pending = b""
    want = size * 2
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        pending += data
        while len(pending) >= want:
            yield samples(pending[:want])
            pending = pending[want:]
    if len(pending) >= 2:
        yield samples(pending[:len(pending) - len(pending) % 2])


def samples(raw):
    values = array.array("h")
    values.frombytes(raw)
    if sys.byteorder == "big":
        values.byteswap()
    return array.array("f", (value / 32768.0 for value in values))


def join(left, right):
    return (left + " " + right).strip() if left and right else left or right


def check_language(engine, language, languages):
    if language and languages and language not in languages:
        raise ValueError(engine + " cannot use the language " + repr(language) + ". Use one of: " + ", ".join(languages))


def needle(model, language):
    from needle.agent.whistle import LANGUAGES, Whistle
    check_language("This Needle model", language, LANGUAGES)
    whistle = Whistle(weights=model)
    emit({"type": "ready", "streaming": True, "languages": list(LANGUAGES), "detect": True})
    committed = ""
    tentative = ""
    for step in whistle.stream(chunks(SAMPLE_RATE), language=language or None):
        committed = join(committed, (step.get("text") or "").strip())
        pending = (step.get("pending") or "").strip()
        if pending != tentative or step.get("text"):
            tentative = pending
            emit({"type": "text", "committed": committed, "tentative": tentative})
    emit({"type": "final", "text": join(committed, tentative)})


def transcribe_cpp(model_path, language):
    import transcribe_cpp
    model = transcribe_cpp.Model(model_path)
    capabilities = model.capabilities
    languages = list(capabilities.languages)
    check_language("This transcribe.cpp model", language, languages)
    if not language and not capabilities.supports_language_detect and len(languages) > 1:
        raise ValueError("This transcribe.cpp model cannot detect the language. Set one of: " + ", ".join(languages))
    ready = {"type": "ready", "languages": languages, "detect": capabilities.supports_language_detect}
    with model.session() as session:
        if not capabilities.supports_streaming:
            emit({**ready, "streaming": False})
            audio = array.array("f")
            for chunk in chunks(SAMPLE_RATE):
                audio.extend(chunk)
            emit({"type": "final", "text": session.run(audio, language=language or None).text.strip() if audio else ""})
            return
        with session.stream(language=language or None) as stream:
            emit({**ready, "streaming": True})
            for chunk in chunks(SAMPLE_RATE // 4):
                update = stream.feed(chunk)
                if update.committed_changed or update.tentative_changed:
                    text = stream.text()
                    emit({"type": "text", "committed": text.committed.strip(), "tentative": text.tentative.strip()})
            stream.finalize()
            emit({"type": "final", "text": stream.text().display.strip()})


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: worker <needle|transcribe.cpp> <model> <language>")
    engine, model, language = sys.argv[1], sys.argv[2], sys.argv[3].strip()
    if engine == "needle":
        needle(model, language)
    elif engine == "transcribe.cpp":
        transcribe_cpp(model, language)
    else:
        sys.exit("unknown engine " + engine)


try:
    main()
except Exception as error:
    sys.stderr.write(type(error).__name__ + ": " + str(error) + "\n")
    sys.exit(1)
