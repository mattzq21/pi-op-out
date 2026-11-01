import json
import sys

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

SIZE = 80
window = Gtk.Window(title='pw-drag-source')
window.set_default_size(SIZE, SIZE)
window.set_decorated(False)
source = Gtk.EventBox()
window.add(source)
window.move(int(sys.argv[1]), int(sys.argv[2]))
window.show_all()
state = {'uris': [], 'text': None, 'context': None}


def data_get(_widget, _context, selection, info, _time):
    if info == 0:
        selection.set_uris(state['uris'])
    else:
        selection.set_text(state['text'], -1)


def begin(_widget, context):
    state['context'] = context


def end(_widget, _context):
    state['context'] = None


source.connect('drag-data-get', data_get)
source.connect('drag-begin', begin)
source.connect('drag-end', end)


def run(command):
    action = command['action']
    if action == 'prepare':
        state['uris'] = [GLib.filename_to_uri(path, None) for path in command['files']]
        state['text'] = command.get('text')
        targets = Gtk.TargetList.new([])
        if state['uris']:
            targets.add_uri_targets(0)
        if state['text'] is not None:
            targets.add_text_targets(1)
        actions = Gdk.DragAction(0)
        for bit, value in ((1, Gdk.DragAction.COPY), (2, Gdk.DragAction.LINK), (16, Gdk.DragAction.MOVE)):
            if command['mask'] & bit:
                actions |= value
        source.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [], actions)
        source.drag_source_set_target_list(targets)
        _, x, y = window.get_window().get_origin()
        return {'x': x + SIZE // 2, 'y': y + SIZE // 2}
    if action == 'cancel':
        if state['context']:
            Gtk.drag_cancel(state['context'])
        return None
    raise ValueError('Unknown action ' + action)


def answer(channel, _condition):
    line = channel.readline()
    if not line:
        Gtk.main_quit()
        return False
    try:
        reply = {'ok': True, 'value': run(json.loads(line))}
    except Exception as error:
        reply = {'ok': False, 'error': str(error)}
    sys.stdout.write(json.dumps(reply) + '\n')
    sys.stdout.flush()
    return True


GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.IO_IN | GLib.IO_HUP, answer)
sys.stdout.write(json.dumps({'ready': True}) + '\n')
sys.stdout.flush()
Gtk.main()
