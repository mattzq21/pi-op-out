"""Piop dictation worker: streams 16 kHz mono s16le PCM from stdin into a speech model.

Usage: python -c <this script> <engine> <model>
engine is "needle" (Cactus Whistle through the cactus-needle package) or "transcribe.cpp" (the transcribe-cpp package).
Writes one JSON object per line to stdout:
  {"type": "ready", "streaming": bool}                       after the model loads
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


def needle(model):
    from needle.agent.whistle import Whistle
    whistle = Whistle(weights=model)
    emit({"type": "ready", "streaming": True})
    committed = ""
    tentative = ""
    for step in whistle.stream(chunks(SAMPLE_RATE)):
        committed = join(committed, (step.get("text") or "").strip())
        pending = (step.get("pending") or "").strip()
        if pending != tentative or step.get("text"):
            tentative = pending
            emit({"type": "text", "committed": committed, "tentative": tentative})
    emit({"type": "final", "text": join(committed, tentative)})


def transcribe_cpp(model_path):
    import transcribe_cpp
    model = transcribe_cpp.Model(model_path)
    with model.session() as session:
        if not model.capabilities.supports_streaming:
            emit({"type": "ready", "streaming": False})
            audio = array.array("f")
            for chunk in chunks(SAMPLE_RATE):
                audio.extend(chunk)
            emit({"type": "final", "text": session.run(audio).text.strip() if audio else ""})
            return
        emit({"type": "ready", "streaming": True})
        with session.stream() as stream:
            for chunk in chunks(SAMPLE_RATE // 4):
                update = stream.feed(chunk)
                if update.committed_changed or update.tentative_changed:
                    text = stream.text()
                    emit({"type": "text", "committed": text.committed.strip(), "tentative": text.tentative.strip()})
            stream.finalize()
            emit({"type": "final", "text": stream.text().display.strip()})


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: worker <needle|transcribe.cpp> <model>")
    engine, model = sys.argv[1], sys.argv[2]
    if engine == "needle":
        needle(model)
    elif engine == "transcribe.cpp":
        transcribe_cpp(model)
    else:
        sys.exit("unknown engine " + engine)


try:
    main()
except Exception as error:
    sys.stderr.write(type(error).__name__ + ": " + str(error) + "\n")
    sys.exit(1)
