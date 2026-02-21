<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Editor</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="header">Header</header>
  <main class="main">
    <section class="content-area">
      <textarea id="content" class="content"></textarea>
    </section>
    <section class="toolbar">
      <button class="button" id="bold">B</button>
      <button class="button" id="italic">I</button>
      <button class="button" id="underline">U</button>
      <button class="button" id="preview">Preview</button>
      <button class="button" id="save">Save</button>
      <button class="button" id="undo">Undo</button>
      <button class="button" id="redo">Redo</button>
    </section>
    <section class="preview-area">
      <div id="preview" class="preview"></div>
    </section>
  </main>
  <footer class="footer">Footer</footer>
</body>
</html>