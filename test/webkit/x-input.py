import ctypes
import json
import sys

x11 = ctypes.CDLL('libX11.so.6')
xtst = ctypes.CDLL('libXtst.so.6')
Window = ctypes.c_ulong
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = Window
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XQueryTree.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(Window), ctypes.POINTER(Window), ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]
x11.XFetchName.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(ctypes.c_char_p)]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XRaiseWindow.argtypes = [ctypes.c_void_p, Window]
x11.XSetInputFocus.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_ulong]
x11.XTranslateCoordinates.argtypes = [ctypes.c_void_p, Window, Window, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(Window)]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit('Cannot open the X display')
root = x11.XDefaultRootWindow(display)


def windows(parent):
    root_return, parent_return = Window(), Window()
    children = ctypes.POINTER(Window)()
    count = ctypes.c_uint()
    if not x11.XQueryTree(display, parent, ctypes.byref(root_return), ctypes.byref(parent_return), ctypes.byref(children), ctypes.byref(count)):
        return
    found = [children[index] for index in range(count.value)]
    if children:
        x11.XFree(children)
    for window in found:
        yield window
        yield from windows(window)


def find(title):
    for window in windows(root):
        name = ctypes.c_char_p()
        if x11.XFetchName(display, window, ctypes.byref(name)) and name.value:
            matches = title in name.value.decode('utf-8', 'replace')
            x11.XFree(name)
            if matches:
                return window
    return None


def origin(window):
    x, y, child = ctypes.c_int(), ctypes.c_int(), Window()
    x11.XTranslateCoordinates(display, window, root, 0, 0, ctypes.byref(x), ctypes.byref(y), ctypes.byref(child))
    return [x.value, y.value]


def run(command):
    action = command['action']
    if action == 'find':
        return find(command['title'])
    if action == 'focus':
        x11.XRaiseWindow(display, command['window'])
        x11.XSetInputFocus(display, command['window'], 2, 0)
    elif action == 'origin':
        return origin(command['window'])
    elif action == 'move':
        xtst.XTestFakeMotionEvent(display, -1, command['x'], command['y'], 0)
    elif action == 'button':
        xtst.XTestFakeButtonEvent(display, command['button'], 1 if command['down'] else 0, 0)
    else:
        raise ValueError('Unknown action ' + action)
    x11.XSync(display, 0)
    return None


for line in sys.stdin:
    try:
        reply = {'ok': True, 'value': run(json.loads(line))}
    except Exception as error:
        reply = {'ok': False, 'error': str(error)}
    sys.stdout.write(json.dumps(reply) + '\n')
    sys.stdout.flush()
