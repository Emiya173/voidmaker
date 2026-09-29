import QtQuick

Image {
    id: glyph
    property string name: "chat"
    property color ink: "#f0e3ed"
    readonly property var paths: ({
        chat: "M3 4h18v13H10l-5 4v-4H3zM7 9h10M7 13h7",
        mic: "M9 3h6v11H9zM5 10v5l3 3h8l3-3v-5M12 18v3M8 21h8",
        work: "M4 3h16v18H4zM7 3v7h10V3M8 14h8v7M10 17v4M14 17v4",
        send: "m5 12 7-7 7 7M12 5v15",
        plus: "M12 4v16M4 12h16",
        close: "m6 6 12 12M6 18 18 6",
        stop: "M6 6h12v12H6z",
        down: "m6 9 6 6 6-6",
        check: "m4 12 5 5L20 6",
        settings: "M3 6h18M3 12h18M3 18h18M7 3v6M16 9v6M10 15v6",
        expand: "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7",
        back: "m10 5-7 7 7 7M3 12h18",
        eye: "M2 9h3V6h14v3h3v6h-3v3H5v-3H2zM10 9h4v6h-4z",
        history: "M5 5h15v15H5M3 3v6h6M3 9l4-4M12 8v5h5",
        loop: "M4 8h14l-3-3M20 16H6l3 3M20 6v5M4 18v-5",
        image: "M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M15 7h2",
        cube: "m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10",
        hide: "M4 12h16"
    })
    width: 22; height: 22
    sourceSize.width: width * Screen.devicePixelRatio
    sourceSize.height: height * Screen.devicePixelRatio
    source: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="' + (paths[name] || paths.chat) + '" fill="none" stroke="' + ink + '" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter"/></svg>')
}
