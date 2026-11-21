# Плагины UXP без Creative Cloud: best practices

**Дата:** 2026-11-21
**Проект:** UXP-плагин Halation для Photoshop (macOS и Windows); у конечного пользователя нет Creative Cloud Desktop
**Метки:** **[вывод]** — моё заключение, которое ни один источник прямо не подтверждает. Без метки: факт со ссылкой из раздела 8.
**Как искали:** сначала по-русски, затем по-английски. Firecrawl (38 вызовов) и Exa (2 вызова), исходники и скрипты читали через встроенный WebFetch и GitHub. Сборки Photoshop из неофициальных источников не рассматривались.

---

## 1. Установка без Creative Cloud: пути

**Вопрос закрыт.** Пользователь сам проверил: на его Photoshop без CC установка «положить .ccx в папку» работает. Ниже — все пути, найденные в источниках, для инструкции по установке.

Одна оговорка для инструкции: по источникам Photoshop подхватывает **распакованную** папку плагина, а запакованный `.ccx` в `Plug-ins` не появлялся (2021) [12]. Стоит уточнить у пользователя, в какую именно папку он кладёт файл и распаковывает ли его, чтобы инструкция совпала с тем, что у него реально работает.

### 1.1 Папка `Plug-ins` конкретной версии Photoshop

Официальная справка Adobe [1]; для UXP-плагинов этот путь подтверждают вендор, форумы и русскоязычный опыт [3][4][5]:

| ОС | Путь |
|---|---|
| macOS | `/Applications/Adobe Photoshop <версия>/Plug-ins/` |
| Windows | `C:\Program Files\Adobe\Adobe Photoshop <версия>\Plug-ins\` |

Пример: `/Applications/Adobe Photoshop 2026/Plug-ins/com.example.halation/manifest.json`.

- Файл `manifest.json` должен лежать прямо в папке плагина, без лишней вложенности [5].
- Нужны права администратора: на macOS система спросит пароль, на Windows — подтверждение [3][5].
- После установки новой мажорной версии Photoshop папку придётся положить заново: `Plug-ins` своя у каждой версии [1][5].
- После копирования Photoshop нужно перезапустить [3].

### 1.2 Общая папка Creative Cloud для плагинов

Официальная справка Adobe [1]: плагины отсюда загружаются во всех установленных версиях Photoshop.

| ОС | Путь |
|---|---|
| macOS | `/Library/Application Support/Adobe/Plug-Ins/CC` |
| Windows | `C:\Program Files\Common Files\Adobe\Plug-Ins\CC` |

**[вывод]** Справка говорит о плагинах вообще. Работает ли эта папка для UXP, в источниках не подтверждено.

### 1.3 Пользовательский каталог UXP и реестр `PS.json`

Так ставят плагины без CC проекты TypeR (macOS, Photoshop 2026) и Fulla (Windows) [6][7][8][9]:

| | macOS | Windows |
|---|---|---|
| Папка плагина | `~/Library/Application Support/Adobe/UXP/Plugins/External/<id>_<version>/` | `%APPDATA%\Adobe\UXP\Plugins\External\<id>\` |
| Реестр | `~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/PS.json` | `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json` |

- Photoshop игнорирует папку в `External`, если её нет в `PS.json` [6].
- Если `PS.json` прочитать не удалось, UXP сканирует папки `Plugins\External` напрямую (лог Photoshop 24.0.1) [10].
- Права администратора не нужны [6][8].

Запись в `PS.json` (верхний уровень — объект с массивом `plugins`; файл в UTF-8 без BOM) [7][9]:

```json
{
  "plugins": [
    {
      "hostMinVersion": "24.4.0",
      "name": "Halation",
      "path": "$localPlugins/External/com.example.halation_1.0.0",
      "pluginId": "com.example.halation",
      "status": "enabled",
      "type": "uxp",
      "versionString": "1.0.0"
    }
  ]
}
```

`$localPlugins` — буквальный текст. На Windows путь пишется через обратную косую черту, в JSON экранированную: `"$localPlugins\\External\\com.example.halation"` [9].

### 1.4 Системные каталоги UXP (их ведёт CC; мы туда не пишем)

- Windows: `C:\Program Files\Common Files\Adobe\UXP\Plugins\External` и `C:\Program Files\Common Files\Adobe\UXP\PluginsInfo\v1\PS.json` [10][11].
- macOS: источник не найден.

### 1.5 UPIA, если вдруг есть на машине

UPIA есть в составе CC Desktop и корпоративных пакетов Adobe; отдельно не распространяется [2]:

- macOS: `/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent --install <файл.ccx>`
- Windows: `"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install <файл.ccx>`

### 1.6 Что важно для инструкции

- Один и тот же плагин нельзя ставить двумя способами одновременно: у копий один `id`, и они конфликтуют [8]. Перед обновлением удалять старую копию.
- Photoshop 27.5 на macOS: если домашняя папка лежит на внешнем диске, меню Plugins становится серым после установки плагина [14].
- Установка `.ccx` не поддерживается, если Photoshop стоит не на загрузочном диске или на Windows ARM [13].

---

## 2. Манифест для распространения вне Marketplace

### 2.1 Шаблон

```json
{
  "manifestVersion": 5,
  "id": "com.example.halation",
  "name": "Halation",
  "version": "1.0.0",
  "main": "index.html",
  "host": {
    "app": "PS",
    "minVersion": "24.4.0",
    "data": { "apiVersion": 2 }
  },
  "requiredPermissions": {
    "localFileSystem": "plugin"
  },
  "entrypoints": [
    {
      "type": "panel",
      "id": "halationPanel",
      "label": { "default": "Halation" },
      "minimumSize": { "width": 240, "height": 360 },
      "maximumSize": { "width": 2000, "height": 2000 },
      "preferredDockedSize": { "width": 280, "height": 520 },
      "preferredFloatingSize": { "width": 280, "height": 520 },
      "icons": [
        { "width": 23, "height": 23, "path": "icons/panel-dark.png",  "scale": [1, 2], "theme": ["darkest", "dark", "medium"] },
        { "width": 23, "height": 23, "path": "icons/panel-light.png", "scale": [1, 2], "theme": ["lightest", "light"] }
      ]
    }
  ],
  "icons": [
    { "width": 24, "height": 24, "path": "icons/plugin.png", "scale": [1, 2], "theme": ["all"], "species": ["pluginList"] }
  ]
}
```

### 2.2 Пояснения

- **Обязательные поля верхнего уровня:** `manifestVersion`, `id`, `name`, `version`, `host`, `entrypoints` [15].
- **`host` — объект, а не массив.** Массив допустим только в разработке. UDT при упаковке сам превращает массив в объект; ручной архив с массивом даёт ошибку установки `-4` (Manifest parse failure) и не проходит в Marketplace [15][19][24][25]. Для распакованной папки это тоже критично [5].
- **`minVersion: "24.4.0"`** нужен из-за Imaging API [27]. Если плагин ставится через `PS.json`, это же значение пишется в `hostMinVersion` [9].
- **`apiVersion: 2`** при `minVersion` ≥ 23.0 и так выставляется по умолчанию; `apiVersion: 1` устарел, и его поддержку уберут [17]. Явное указание не мешает.
- **`requiredPermissions`.** В манифесте v5 то, что не объявлено, не предоставляется [16]. Нам не нужны ни сеть, ни доступ к файлам пользователя. `localFileSystem: "plugin"` и так значение по умолчанию [16]: доступны папка плагина, папка данных и временная папка [38].
- **Размеры панели** — `minimumSize`, `maximumSize`, `preferredDockedSize`, `preferredFloatingSize`, каждый вида `{width, height}`. Photoshop может их не соблюдать [15].
- **Иконки.**
  - Иконка плагина (в корне манифеста) показывается в панели Plugins: 24×24, @2x — 48×48, `species: ["pluginList"]`. Иконка панели (внутри entrypoint): 23×23, @2x — 46×46 [15][18].
  - При `scale: [1, 2]` UXP ищет файлы с суффиксами: для `icons/icon_D.png` — `icons/icon_D@1x.png` и `icons/icon_D@2x.png`. Если иконок нет, в логе будут только предупреждения [23].
  - Общий справочник UXP называет поле иконки внутри entrypoint `icon` (в единственном числе) [15]. **[вывод]** Перед сборкой сверить точное имя ключа с официальным примером Photoshop.
  - SVG поддерживается не полностью, PNG надёжнее [39].
- **Plugin ID.**
  - Для распространения вне Marketplace регистрировать ID не нужно, достаточно уникальной строки: UDT сам генерирует ID вида `Test-xjluvc` [20].
  - `id` разделяет контексты, хранилище и ошибки разных плагинов [15]. ID из Developer Distribution обязателен только для Marketplace [20][22].
  - Для будущей версии в Marketplace брать **другой** ID. Иначе CC Desktop станет проверять покупку в Marketplace и откажет в установке [20].
  - **[вывод]** Удобнее обратная DNS-запись без пробелов и кириллицы: ID станет именем папки.

---

## 3. Imaging API на практике

### 3.1 Основы

- Модуль: `const imaging = require("photoshop").imaging;`. Методы: `getPixels`, `putPixels`, `getSelection`, `getLayerMask` / `putLayerMask`, `createImageDataFromBuffer`, `encodeImageData` [26].
- `getPixels({documentID, layerID, sourceBounds, targetSize, colorSpace, colorProfile, componentSize, applyAlpha})` возвращает `{imageData, sourceBounds, level}`. Без `layerID` берётся композит документа [26].
- `await imageData.getData()` для 8 бит возвращает `Uint8Array`, по умолчанию в формате chunky (RGBA подряд) [26].
- `putPixels({layerID, imageData, replace, targetBounds, commandName})`: целевой слой **обязан быть пиксельным**. Без `targetBounds` пиксели кладутся в точку (0, 0) документа [26].
- В буфере для `createImageDataFromBuffer` должно быть ровно `width × height × components` элементов [26].
- **Модальный режим.** Изменения документа требуют `executeAsModal` [28]. По опыту разработчиков, `getPixels` тоже вызывают внутри модального режима: «нужно выполнять в модальном режиме, иначе не работает» [36][33].

### 3.2 Цвет: 8-bit sRGB без неявных конверсий

- Если `colorSpace` совпадает с документом и `colorProfile` не указан, данные приходят в профиле документа, без конверсии [26].
- Если у буфера пустой `colorProfile`, при записи используется профиль целевого документа [26].
- Конверсии между профилями «заметно медленные»; Adobe советует работать в профиле документа [26].
- **Практика:** читать с `componentSize: 8` без `colorProfile`. Буфер для записи создавать с **той же строкой профиля**, что вернул `getPixels` (`imageData.colorProfile`).
- **[вывод]** До запуска проверять, что документ RGB и 8 бит, и предупреждать, если профиль не `sRGB IEC61966-2.1`: линейная модель плагина построена на кривой sRGB.
- Диапазоны значений: 8 бит — 0…255; 16 бит — 0…32768 (а не 65535); 32 бит — 0…1 и выше [26].
- **[вывод, рекомендация]** Перевод sRGB → линейный свет для 8 бит — таблица на 256 значений `Float32Array`. Обратный перевод — таблица с шагом 1/4096 или формула.

### 3.3 Прозрачность, пустые слои, границы

- Области без пикселей **обрезаются**: буфер содержит только наименьший прямоугольник с непустыми пикселями, и возвращённый `sourceBounds` может быть меньше запрошенного [26][35]. Писать результат нужно с `targetBounds = {left, top}` из **возвращённого** `sourceBounds`.
- Начало координат пиксельного слоя может не совпадать с (0, 0); границы слоя без эффектов — `layer.boundsNoEffects` [26][31].
- Если в слое есть прозрачность, данные приходят с альфой (`components: 4`). `applyAlpha: true` кладёт пиксели на **белую** подложку, нам это не подходит [26].
- **[вывод]** У пустого слоя обрезанная область может оказаться нулевой. Это случай «нечего делать», а не ошибка.
- **[вывод, рекомендация]** Ореол — свечение, выходящее за края объекта, поэтому выходной буфер нужно расширить на радиус размытия и обрезать по границам документа.

### 3.4 Смарт-объекты, текст, выделение

- Запись `putPixels` идёт только в пиксельный слой [26]. Мы пишем в новый пиксельный слой, поэтому тип исходного слоя для записи не важен.
- Ограничений `getPixels` для смарт-объектов и текста документация не описывает. **[вывод]** Проверить у пользователя на смарт-объекте, тексте и группе. Запасной вариант — режим «по видимому»: композит, `getPixels` без `layerID`.
- Kind слоя читается из свойства `layer.kind` (22.5+) [31]. Это позволяет заранее предупредить пользователя о неподдерживаемом слое.
- Выделение: `getSelection` возвращает маску в оттенках серого. Вместо `getSelection` можно взять `app.activeDocument.selection.bounds` [26][35]. **[вывод, рекомендация]** Если выделение есть, наложить его на слой ореола как маску через `putLayerMask` (одноканальные данные: `Grayscale`, профиль `Gray Gamma 2.2`) [26], а не обрезать сами вычисления.

### 3.5 Новый слой и запись в него

- Создание: `await doc.createPixelLayer({name: "Halation", opacity: 100, blendMode: …})` — Photoshop 24.1+. Общая форма `doc.createLayer(options)` — с 23.0 [29]. Параметры: `name`, `opacity`, `blendMode`, `fillNeutral`, `group` (обтравочная маска) [30].
- Положение: `layer.move(relativeObject, insertLocation)` (23.0+) с `placeBefore` / `placeAfter`; `placeInside` допустим только для групп [31]. `layer.duplicate()` создаёт копию **над** исходным слоем [31].
- **[вывод, рекомендация]** Порядок такой: создать слой, затем явно поставить его над исходным через `move(source, ElementPlacement.PLACEBEFORE)`, не полагаясь на то, какой слой был активным.
- **[вывод, рекомендация]** Ореол выдавать отдельным слоем с режимом наложения (Screen или Linear Dodge, по модели), чтобы силу эффекта можно было менять непрозрачностью слоя.

### 3.6 `executeAsModal`: прогресс и отмена

- С `apiVersion: 2` любое изменение Photoshop (документа и даже UI или настроек) требует модального режима [28].
- Вызов: `await require("photoshop").core.executeAsModal(fn, {commandName: "Halation"})`. Поле `commandName` обязательно (23.0+) [28].
- Объект `executionContext` передаёт `isCancelled`, `onCancel`, `reportProgress`, `hostControl` [28].
- Прогресс: `executionContext.reportProgress({value: 0.3})`, значение от 0 до 1. Подпись можно менять: `{value: 0.9, commandName: "Finishing Up"}`. Окно прогресса появляется, если операция длится больше двух секунд [28].
- Отмена: пользователь нажимает Esc или кнопку в окне прогресса. Вызовы Photoshop через `await` после отмены бросают исключение сами. **Плотный JS-цикл без точек `await` отменить нельзя**: в нём нужно регулярно проверять `isCancelled` и бросать исключение. Если исключение поймать в `try/catch` и не пробросить дальше, автоматическая отмена ломается [28].
- **[вывод, рекомендация]** Тяжёлую обработку делить на полосы и между ними вставлять `await new Promise(r => setTimeout(r, 0))`. Тогда работают отмена и прогресс, а панель не замирает.
- С 25.10, если модальный режим занят другим плагином, запрос ждёт до `timeOut` (по умолчанию 1 с), а текст ошибки называет мешающий плагин. До 25.10 ошибка «host is in a modal state» приходила сразу [28]. Ошибку надо ловить и показывать пользователю понятным текстом.

### 3.7 Один шаг отмены (Undo)

```js
await core.executeAsModal(async (ctx) => {
  const id = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Halation" });
  // создать слой, putPixels, маска…
  await ctx.hostControl.resumeHistory(id);   // commit = true по умолчанию
}, { commandName: "Halation" });
```

- Шаг истории создаётся, только если документ действительно изменился между `suspendHistory` и `resumeHistory` [28].
- Когда модальная функция заканчивается, Photoshop сам возобновляет историю: при нормальном выходе фиксирует изменения, **при исключении откатывает** [28]. Отмена пользователем или ошибка оставят документ нетронутым.

### 3.8 Память, скорость и известные баги на больших изображениях (24–60 Мп)

**Что говорит Adobe** [26]:
- При большом расходе памяти в консоли UDT появляется «Plugin exceeds memory limit. Currently used memory 600».
- Методы, возвращающие пиксели, асинхронные: возможен ввод-вывод на диск.
- Запрашивать **минимально нужный** `targetSize`: при уменьшении Photoshop берёт кэш-уровень пирамиды, а это «может дать драматический прирост скорости». Число уровней задаёт настройка Performance Cache Levels (`imageCacheLevels`, 1–8) [26][32].
- `dispose()` у каждого `PhotoshopImageData` сразу после использования.

**Что нашли разработчики:**
- **Утечка памяти при `getData()`** в Photoshop 26.5 (2025): каждый вызов съедал память размером с буфер, даже при `dispose()`. В 25.12 утечки нет [33]. В январе 2026 другой разработчик не воспроизвёл её на 26.11.2 и 27.1.0. Ещё один в декабре 2025 (27.3.0) избежал утечки, перенеся обработку в WebAssembly [33].
- **`getPixels` возвращает пиксели не из того места** (27.3.1, UXP 9.0.2, март 2026): при `sourceBounds` 1200×1200 и `targetSize` 600×600 (ровно вдвое меньше) данные смещены вверх и влево. Обход — запросить 1201×1201. Adobe баг не подтвердила [34].
- **`targetSize` растягивает картинку**, если пропорции не совпадают с источником [35]. Задавать только одну сторону: вторая посчитается пропорционально [26].
- `dispose()` ставить в `finally`, чтобы буфер освобождался и при ошибке [37].

**Расчёт [вывод]:**
- 60 Мп × 4 канала × 4 байта (float32) ≈ 960 МБ на один буфер; вместе с исходником и результатом — больше 2 ГБ.
- Даже 24 Мп × 3 канала × float32 ≈ 288 МБ.
- Обработка целого кадра во float32 упирается в лимит из предупреждения Adobe.

**Рекомендации [вывод]:**
1. Ореол — низкочастотная составляющая, его разумно считать на уменьшенной копии. Читать через `targetSize` с одной стороной (быстро за счёт пирамиды; масштаб не ровно 1/2, чтобы обойти баг [34]), размывать на малом разрешении. Затем полосами по 256–512 строк читать полное разрешение, увеличивать ореол билинейно и смешивать.
2. Если нужен расчёт на полном разрешении — тайлы с перекрытием не меньше радиуса размытия.
3. В горячих циклах переиспользовать заранее выделенные typed arrays, не создавая новые на каждой полосе.
4. Если чистый JS будет медленным, есть WebAssembly: UXP его поддерживает (пример `wasm-rust-sample`) [38], и по отчёту выше он помог с памятью [33].
5. Проверить у пользователя на файле 60 Мп: время, пик памяти Photoshop, отсутствие роста памяти при повторных запусках.

---

## 4. Интерфейс в UXP

### 4.1 Виджеты: Spectrum UXP widgets или Spectrum Web Components

- Встроенные виджеты (`sp-slider`, `sp-radio-group`, `sp-button`, `sp-textfield` и другие) входят в UXP и не требуют установки [40]. `sp-slider` есть с UXP 4.1. Атрибуты: `min`, `max`, `value`, `value-label` (единица, например `%`), `show-value`, `variant="filled"`. События: `input` во время перетаскивания и `change` в конце [41].
- SWC: Adobe рекомендует начинать с них. Это около 30 компонентов, работают с UXP 7.0, ставятся из npm по одному (`@swc-uxp-wrappers/...`) и импортируются в код [40][42].
- **[вывод, рекомендация]** Для небольшой панели без сборщика (bundler) хватит встроенных `sp-*`: меньше инструментов и точек отказа.
- Известные проблемы `sp-*`: у `sp-dropdown` обязательно задавать ширину; числовой `sp-textfield` выдаёт ложные ошибки проверки; фокус с клавиатуры на кнопках не виден [39].
- Переключатель режима (sRGB / своя кривая) — `sp-radio-group` [41].
- **[вывод, рекомендация]** Превью пересчитывать на `input` с ограничением частоты (не чаще раза за кадр, через `requestAnimationFrame` или таймер), а запуск полной обработки делать только по кнопке.

### 4.2 Редактор кривой на `<canvas>`

**Возможности canvas в UXP** [43][44]:
- Есть с UXP 7.0, контекст только `2d`, по документации «только базовые фигуры».
- В справочнике перечислены: `beginPath`, `closePath`, `moveTo`, `lineTo`, `arc`, `arcTo`, `bezierCurveTo`, `quadraticCurveTo`, `rect`, `stroke`, `fill`, `fillRect`, `strokeRect`, `clearRect`, `createLinearGradient`, `createRadialGradient`; свойства `lineWidth`, `lineJoin`, `lineCap`, `globalAlpha`, `fillStyle`, `strokeStyle`; объект `Path2D`.
- **Не перечислены:** `fillText`, `drawImage`, `putImageData` / `getImageData`, `save` / `restore`, `translate` / `scale` / `setTransform`, `setLineDash`. **[вывод]** Считать, что их нет.

**Ограничения:**
- **На Windows не работают `createLinearGradient()`, `createRadialGradient()` и `clearRect()`** [39]. Очищать холст через `fillRect` цветом фона, градиенты не использовать.
- `window.devicePixelRatio` всегда равен 1 [39]. **[вывод]** Чёткость линий на Retina проверить у пользователя.

**Указатель:**
- `setPointerCapture`, `releasePointerCapture`, `hasPointerCapture` есть с UXP 7.1 [42]. Перетаскивание точек — на `pointerdown` / `pointermove` / `pointerup` с захватом указателя.
- HTML5 Drag and Drop не поддерживается [39], но для редактора кривой он не нужен.
- «Интерактивные элементы перехватывают большинство событий» [39]. **[вывод]** Canvas не вкладывать в кнопки и другие интерактивные виджеты.

**Как построить редактор [вывод, рекомендация]:**
1. Сетка и диагональ — `moveTo` / `lineTo` / `stroke`; кривая — ломаная по 128–256 точкам интерполированной функции (монотонный кубический сплайн считать в JS-ядре); точки — `arc` + `fill`.
2. Подписи осей и значений — обычными HTML-элементами поверх canvas: `fillText` нет.
3. Координаты указателя переводить через `getBoundingClientRect()`; ограничивать по осям и не давать точкам меняться местами по X.
4. Добавление точки — щелчок по пустому месту, удаление — двойной щелчок или перетаскивание за пределы холста.
5. Сам расчёт кривой — в чистом ядре (тестируется в Node); canvas только рисует.
6. **[вывод]** В справочнике нет PS-версии, где появился UXP 7.1. Если `setPointerCapture` окажется недоступен, слушать `pointermove` / `pointerup` на `document`.

### 4.3 Выбор цвета ореола

**Системная палитра Photoshop через `batchPlay`.** Рабочий вариант с форума, обёрнутый в `executeAsModal` (2022) [46]:

```js
const { core, action } = require("photoshop");
let picked;
await core.executeAsModal(async () => {
  const res = await action.batchPlay([{
    _obj: "showColorPicker",
    _target: [{ _ref: "application" }]
    // можно передать начальный цвет: color: { _obj: "RGBColor", red, green, blue }
  }], {});
  picked = res[0];
}, { commandName: "Pick halation color" });
```

- Формат результата в источниках разный: `res[0].RGBFloatColor` в примере 2020 года [45]; `res[0].color`, если начальный цвет задан в Lab (2021) [47]. Имя зелёного канала в дескрипторах тоже обсуждалось («grain» или «green») [47][46].
- Как определяется отмена палитры, не описано. На форуме есть тема о том, что палитра иногда сама закрывает модальный диалог, из которого её вызвали [46].
- Начальный цвет передаётся полем `color` (`RGBColor` или `labColor`), а также подписью `context` [45][47].
- **[вывод, рекомендация]**
  1. Первым делом в сборке для пользователя логировать весь `res[0]`, чтобы узнать реальные ключи.
  2. Разбор делать устойчивым: принимать и `RGBFloatColor`, и `color`; `green` и `grain`; диапазоны 0–1 и 0–255.
  3. Пустой результат или исключение считать отменой.
  4. Вызывать палитру из панели, а не из `<dialog>`.

**Запасные варианты [вывод]:** в Spectrum-виджетах цветового компонента нет [40]. Можно собрать свой выбор цвета из трёх `sp-slider` (оттенок, насыщенность, яркость) с образцом-`div`, а пресеты (тёплый красный, оранжевый) сделать кнопками. Такой вариант не зависит от `batchPlay` и годится как резервный, если палитра поведёт себя нестабильно.

### 4.4 Быстрое превью

**Источник кадра:**
- `getPixels` с маленьким `targetSize` (одна сторона, например `{width: 320}`) читает уровень пирамиды и работает быстро [26]. С учётом бага [34] не брать ровно половину размера источника.
- **[вывод, рекомендация]** Уменьшенный исходник получать **один раз** (внутри `executeAsModal`) при открытии панели, смене документа или слоя и кнопкой «Обновить». Держать его в памяти как `Uint8Array`. Тогда движение ползунков не обращается к Photoshop и не занимает модальный режим.

**Вывод на экран — два способа:**
1. `ImageBlob` (UXP 7.0, «включается приложением, сейчас поддерживается Photoshop»): `new ImageBlob(buffer, {width, height, colorSpace: "RGB", colorProfile: "", pixelFormat: "RGB", components: 3, componentSize: 8, hasAlpha: false, type: "image/uncompressed"})`, затем `img.src = URL.createObjectURL(blob)` и `URL.revokeObjectURL(url)`, когда адрес больше не нужен [48]. Без JPEG-сжатия и без вызовов Photoshop. **[вывод]** Это предпочтительный путь для живого превью.
2. `imaging.encodeImageData({imageData, base64: true})` → `img.src = "data:image/jpeg;base64," + data`. Данные должны быть в RGB. Буфер предварительно создаётся через `createImageDataFromBuffer` [26]. Это запасной путь.

**Детали:**
- Прозрачность: превью рисовать на шахматке или на сером фоне, смешивая в JS. В примере `ImageBlob` используется RGB без альфы [48].
- `<img>` внутри `<dialog>` требует явных `width` и `height` [39].
- **[вывод, рекомендация]** Превью считать тем же ядром, что и полную обработку, пересчитывая радиус размытия на масштаб. Тогда превью совпадёт с результатом.

### 4.5 Сохранение настроек

- `window.localStorage` — хранилище «ключ — значение» для настроек. Данные постоянные, но могут быть стёрты: хранить там только то, что можно восстановить [49].
- Альтернатива — файл в `require("uxp").storage.localFileSystem.getDataFolder()`: папка данных плагина, переживает обновления Photoshop [50].
- **[вывод, рекомендация]** Все настройки (режим, точки кривой, цвет, ползунки) хранить в `localStorage` одним JSON с номером схемы. При ошибке разбора возвращаться к значениям по умолчанию.

---

## 5. Сборка `.ccx` и тестирование

### 5.1 Сборка `.ccx` без UXP Developer Tool

**Формат подтверждён.**
- `.ccx` — обычный ZIP; цифровая подпись и метка времени не нужны [20][21]. Adobe советует собирать в UDT, но ручная сборка не запрещена [20].
- Bolt UXP (Hyper Brew), открытый фреймворк для UXP, собирает `.ccx` так: архиватор `archiver`, формат zip, сжатие уровня 9, **содержимое папки `dist` кладётся в корень архива** (`archive.directory("dist", false)`). Значит, `manifest.json` лежит в корне архива [51].
- В каждый `.ccx` Bolt пишет манифест с **одним** объектом `host`. Файл называется `${id}_${host.app}.ccx` [51]. UDT называет пакет похоже: `Test-xjluvc_premierepro.ccx` [20].
- Если в проекте несколько приложений-хостов, Bolt по умолчанию добавляет к `id` суффикс `_ps` [51]. Нам это не нужно: хост один, ID оставляем как есть.

**Рецепт для нашего Mac [вывод: команды собраны по формату выше]:**

```bash
# dist/ содержит manifest.json (host — объект), index.html, index.js, icons/ …
cd dist
zip -r -X -9 ../com.example.halation_PS.ccx . -x '.*' -x '__MACOSX/*'
unzip -l ../com.example.halation_PS.ccx   # проверка: manifest.json в корне, без вложенной папки
```

- `-X` убирает расширенные атрибуты macOS, `-x '.*'` исключает `.DS_Store` и другие скрытые файлы.
- Перед упаковкой скрипт сборки проверяет манифест:
  - JSON разбирается без ошибок;
  - `host` — объект, а не массив;
  - `version` совпадает с версией в имени файла;
  - все файлы, на которые ссылаются `main` и иконки, существуют.
- Альтернатива на Node — тот же `archiver`, как в Bolt [51].
- CLI `uxp plugin package` из `adobe-uxp/devtools-cli` советовал сотрудник Adobe в 2022 году [53]. Поддерживается ли он сейчас, не проверено.
- Ошибка `-4` при установке означает, что манифест не разобрался. Чаще всего виноват массив в `host` [24][25].

### 5.2 Нужны ли UDT и Creative Cloud

- UDT и Photoshop ставятся через CC Desktop [52][59]. Чтобы упаковать плагин в UDT, загружать его в приложение не нужно [20].
- Developer Mode в Photoshop нужен только для загрузки плагинов из UDT [52][54].
- **[вывод]** Нашей схеме UDT не нужен: сборка и `.ccx` делаются скриптом на Mac без Photoshop. Проверку в живом Photoshop проводит пользователь, поэтому в панели нужен встроенный блок диагностики (см. 6.3).

### 5.3 Модульные тесты ядра в Node

- **[вывод, рекомендация]** Ядро (декодирование sRGB, кривая, размытие, смешивание, кодирование, расчёт границ) держать в отдельных модулях без `require("photoshop")` и `require("uxp")`, только на typed arrays. В ядре не использовать API Node (`Buffer`, `fs`): UXP — не Node.
- Запуск — встроенный тест-раннер Node (`node --test`) [55], на синтетических картинках размером 8–64 px.
- Что проверять:
  - таблица sRGB: туда и обратно без потерь на всех 256 значениях;
  - отсутствие NaN и Infinity;
  - альфа исходника не меняется;
  - нулевая сила эффекта возвращает исходные пиксели;
  - симметрия размытия;
  - кривая проходит через свои опорные точки и монотонна;
  - результат совпадает с эталонной (медленной) реализацией на маленьких сетках.
- Отдельный набор — логика границ (`sourceBounds` → `targetBounds`, расширение на радиус, обрезка по документу) с поддельным объектом `imaging`.
- Сборку тоже проверять тестом: распаковать `.ccx` и убедиться, что в корне есть `manifest.json` и что `host` в нём — объект.

### 5.4 Почему плагины не загружаются

- Малейшая ошибка в JSON манифеста (скобка, запятая) ломает загрузку; манифест прогонять через линтер [54].
- `host` массивом вместо объекта [15][25].
- Ошибка `-4` — Manifest parse failure [24].
- `minVersion` выше установленного Photoshop. **[вывод]** Через CC это даёт «Compatible app required»; при ручной установке плагин, вероятно, просто не появится.
- «Compatible app required» в 2026 году бывает и при правильном манифесте: например, если в CC видна только Beta-версия Photoshop [57][13].
- Отсутствующие иконки — только предупреждения в логе, не ошибка [23].
- Невидимые плагины (без панели) в Photoshop 27 после установки из `.ccx` не выполняют стартовый код [58]. **[вывод]** Стартовую логику не класть в `entrypoints.plugin.create`, а запускать из `show` панели.

---

## 6. Подводные камни и диагностика

### 6.1 Что учесть в коде

- `dispose()` всех `PhotoshopImageData` в `finally` [37]. Утечка `getData()` воспроизводилась в Photoshop 26.5 [33].
- `targetSize` не брать ровно вдвое меньше источника [34]; задавать одну сторону [26][35].
- Ошибки модального режима (занят другим плагином) ловить и показывать понятным текстом [28].
- Canvas на Windows: без `clearRect` и градиентов [39].
- Палитра цвета: устойчиво разбирать ответ и считать пустой ответ отменой [45][46][47].

### 6.2 Логи UXP

- В документации UXP для InDesign (до версии 19.2) логи лежат в `~/Library/Caches/UXPLogs/` (macOS) и `C:\Users\<user>\AppData\Local\Temp\UXPLogs` (Windows); брать файл с самой свежей датой [56]. **[вывод]** Для Photoshop, вероятно, те же папки; уточнить у пользователя.
- Что искать в логе: строки `upic::` («Failed to read plugin info file», «Loading plugins from … fallback plugins folder», «Number of plugins added …») [10] и строки с нашим `id` (предупреждения об иконках, ошибки манифеста) [23].

### 6.3 Диагностика силами пользователя

1. Photoshop перезапущен после установки [3][6].
2. Есть пункт **Plugins → Halation**.
3. Путь до `manifest.json` совпадает с инструкцией (раздел 1), лишней вложенности нет.
4. Версия Photoshop не ниже `minVersion`.
5. Пользователь присылает свежий файл из `UXPLogs`.
6. **[вывод, рекомендация]** В самой панели держать скрытый блок «Диагностика»: версии Photoshop и UXP (`require("uxp").versions`; проверить имя свойства), `id` и версия плагина, параметры документа (режим, битность, профиль, размер), время последнего запуска, последняя ошибка со стеком и кнопка «Скопировать отчёт». Раз Photoshop есть только у пользователя, это наш главный канал отладки.

---

## 7. Итог для проекта

1. Установка: пути из раздела 1; инструкцию сверить с тем, как пользователь уже ставит плагин.
2. Манифест v5: `host` — объект, `minVersion: "24.4.0"`, `apiVersion: 2`, минимум разрешений, иконки с суффиксами `@1x` / `@2x`.
3. Вся работа с документом — в одном `executeAsModal` с `suspendHistory` / `resumeHistory`. Новый слой — `createPixelLayer`, затем `move(..., PLACEBEFORE)`. Отмена — `isCancelled` в циклах, прогресс — `reportProgress`.
4. Цвет: читать и писать в профиле документа; проверять RGB, 8 бит, sRGB.
5. Большие файлы: ореол считать на уменьшенной копии и смешивать полосами; `dispose()` в `finally`; при нехватке скорости — WebAssembly.
6. UI: встроенные `sp-*`; кривая на canvas без `clearRect`, градиентов и `fillText`; указатель через `setPointerCapture`; цвет — палитра Photoshop с устойчивым разбором ответа и HSV-ползунками как запасным вариантом; превью через `ImageBlob` из кэшированного уменьшенного кадра.
7. `.ccx` — zip содержимого `dist` с `manifest.json` в корне; ядро тестируется в Node; в панели — блок диагностики.

---

## 8. Источники

**Установка: пути и опыт**

- [1] Adobe HelpX, «Plug-in folder locations in Photoshop»: https://helpx.adobe.com/photoshop/desktop/troubleshoot/tool-feature-issues/photoshop-plug-in-folder-locations.html
- [2] Adobe Developer Blog, «How to Install UXP Plugins Using Command Line Tools» (2022): https://blog.developer.adobe.com/how-to-install-uxp-plugins-using-command-line-tools-a6a62ca4cb1a
- [3] Battle Axe, «Manual install UXP plugin»: https://battleaxe.co/help/manual-install-uxp
- [4] Форум vodkomotornik.ru, «Установка плагина *.ccx в Adobe Photoshop — Требуется совместимое приложение» (2023): https://vodkomotornik.ru/forum/viewtopic.php?t=6788
- [5] Форум Adobe, «Methods for Installing Non-Marketplace Plugins» (2023–2024): https://forums.creativeclouddeveloper.com/t/methods-for-installing-non-marketplace-plugins/6005
- [6] TypeR, `docs/uxp.md`: https://github.com/ScanR/TypeR/blob/master/docs/uxp.md
- [7] TypeR, `installer/install_mac.sh`: https://raw.githubusercontent.com/ScanR/TypeR/master/installer/install_mac.sh
- [8] Fulla, README: https://github.com/toorop/fulla
- [9] Fulla, `installer/install.ps1`: https://raw.githubusercontent.com/toorop/fulla/main/installer/install.ps1
- [10] Adobe Community, лог UXP из Photoshop 24.0.1: https://community.adobe.com/questions-712/photoshop-24-0-1-crashes-when-printing-old-saved-psd-files-1147543/index2.html
- [11] Adobe Community, «Where does Adobe CC stores the 3rd party UXP-Plugin information…» (2025): https://community.adobe.com/questions-712/where-does-adobe-cc-stores-the-3rd-party-uxp-plugin-information-for-photoshop-in-windows-1176927
- [12] Форум Adobe, «How can I launch my plugin without Adobe UXP Developer Tool?» (2021): https://forums.creativeclouddeveloper.com/t/how-can-i-launch-my-plugin-without-adobe-uxp-developer-tool/3195
- [13] Adobe Community, «Photoshop Plugin still shows “Compatible app required”…» (2026, ответы ErinF): https://community.adobe.com/questions-712/photoshop-plugin-still-shows-compatible-app-required-despite-lowering-minimum-version-requirement-1625201
- [14] Adobe Community, «Photoshop 2026 (v27.5.0) Plugins menu greyed out when home directory is on external volume»: https://community.adobe.com/questions-712/photoshop-2026-v27-5-0-plugins-menu-greyed-out-when-home-directory-is-on-external-volume-mac-mini-m4-macos-26-3-1-1556399

**Манифест и ID**

- [15] Adobe, справочник UXP «Manifest»: https://developer.adobe.com/uxp/guides/explanation/concepts/manifest/
- [16] Adobe, «UXP Manifest v5»: https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/
- [17] Adobe, «Photoshop specific manifest properties»: https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v4/photoshop-manifest/
- [18] Adobe, «Icons for Your Plugins»: https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/plugin-icons/
- [19] Adobe, UXP FAQ: https://developer.adobe.com/uxp/faq/
- [20] Adobe, «Package a UXP plugin» (Premiere Pro UXP): https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package/
- [21] Adobe, «Package a UXP plugin» (UXP hub): https://developer.adobe.com/uxp/guides/how-to/distribution/package/
- [22] Adobe Developer Distribution, «Get a Plugin ID»: https://developer.adobe.com/developer-distribution/creative-cloud/docs/guides/plugin-id
- [23] Форум Adobe, «UXP plugin not work when install on Photoshop 2022 (Offline installed version)» (2023): https://forums.creativeclouddeveloper.com/t/uxp-plugin-not-work-when-install-on-photoshop-2022-offline-installed-version/6857
- [24] Форум Adobe, «How to successfully package and install self developed plugins?» (2023): https://forums.creativeclouddeveloper.com/t/how-to-successfully-package-and-install-self-developed-plugins/7245
- [25] Форум Adobe, «Creating ccx packages in Windows without UXP Developer Tool» (2022): https://forums.creativeclouddeveloper.com/t/creating-ccx-packages-in-windows-without-uxp-developer-tool/4984

**Imaging API и Photoshop API**

- [26] Adobe, «Imaging API» (исходник): https://raw.githubusercontent.com/AdobeDocs/uxp-photoshop/main/src/pages/ps-reference/media/imaging.md
- [27] DefinitelyTyped, `types/photoshop/dom/ImagingModule.d.ts` (`@minVersion 24.4`): https://github.com/definitelytyped/definitelytyped/blob/d0797ca8049d43b86ff0666342ebe45aa87f771a/types/photoshop/dom/ImagingModule.d.ts
- [28] Adobe, «executeAsModal» (исходник): https://github.com/AdobeDocs/uxp-photoshop/blob/main/src/pages/ps-reference/media/executeasmodal.md
- [29] Adobe, `Document` (`createPixelLayer`, `createLayer`): https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document
- [30] Adobe, `PixelLayerCreateOptions`: https://developer.adobe.com/photoshop/uxp/2022/ps-reference/objects/createoptions/pixellayercreateoptions
- [31] Adobe, `Layer` (исходник: `move`, `duplicate`, `kind`, `boundsNoEffects`): https://raw.githubusercontent.com/AdobeDocs/uxp-photoshop/main/src/pages/ps-reference/classes/layer.md
- [32] Adobe, `PreferencesPerformance` (`imageCacheLevels`): https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/preferences/preferencesperformance
- [33] Форум Adobe, «[BUG] Imaging API memory leak when reading pixel data» (2025–2026): https://forums.creativeclouddeveloper.com/t/bug-imaging-api-memory-leak-when-reading-pixel-data/10510
- [34] Форум Adobe, «[BUG] Imaging API getPixels() returns pixel data from wrong location» (2026): https://forums.creativeclouddeveloper.com/t/bug-imaging-api-getpixels-returns-pixel-data-from-wrong-location/11802
- [35] Форум Adobe, «Questions about getPisxel» (2023): https://forums.creativeclouddeveloper.com/t/questions-about-getpisxel/7025
- [36] Форум Adobe, «How to get a pixel layer as a base64 PNG?» (2025): https://forums.creativeclouddeveloper.com/t/how-to-get-a-pixel-layer-as-a-base64-png/10723
- [37] ps-cloud-ai-painting-plugin, `docs/UXP_DEVELOPMENT_NOTES.md` (`dispose` в `finally`): https://github.com/lajibi/ps-cloud-ai-painting-plugin/blob/main/docs/UXP_DEVELOPMENT_NOTES.md
- [38] Adobe, «Code Samples» (доступ к файлам, WebAssembly): https://developer.adobe.com/photoshop/uxp/2022/guides/code-samples/

**Интерфейс**

- [39] Adobe, UXP «Known Issues»: https://developer.adobe.com/photoshop/uxp/2022/uxp-api/known-issues
- [40] Adobe, справочник Spectrum (виджеты и SWC): https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-spectrum/
- [41] Adobe, `sp-slider`: https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-spectrum/spectrum-uxp-widgets/user-interface/sp-slider ; примеры: https://adobedocs.github.io/uxp-photoshop/uxp-api/reference-spectrum/Spectrum%20UXP%20Widgets/User%20Interface/sp-slider/
- [42] Adobe, UXP Changelog (UXP 7.0–7.2: canvas, SWC, `setPointerCapture`, `ImageBlob`): https://developer.adobe.com/photoshop/uxp/2022/uxp-api/changelog3-p
- [43] Adobe, `HTMLCanvasElement`: https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/html-elements/html-canvas-element
- [44] Adobe, `CanvasRenderingContext2D`: https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/html-dom/canvas-rendering-context2-d
- [45] Форум Adobe, «UXP — Get user adjustments from displayed dialog?», пост #5 (2020): https://forums.creativeclouddeveloper.com/t/uxp-get-user-adjustments-from-displayed-dialog/2372/5
- [46] Форум Adobe, «Unable to show the color picker» (2022): https://forums.creativeclouddeveloper.com/t/unable-to-show-the-color-picker/5007
- [47] Форум Adobe, «Problem with colorpicker» (2021): https://forums.creativeclouddeveloper.com/t/problem-with-colorpicker/2754
- [48] Adobe, `window.ImageBlob`: https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/image-blob/image-blob ; пример: https://github.com/adobedocs/uxp/blob/f04f65e02065b4cd8c78d9d26bcba2ccf6943c58/src/pages/uxp-api/reference-js/Global%20Members/ImageBlob/ImageBlob.md
- [49] Adobe, `window.localStorage`: https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/data-storage/local-storage
- [50] Adobe, `require('uxp').storage` (`getDataFolder`): https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/modules/uxp/persistent-file-storage/storage

**Сборка, отладка, тесты**

- [51] Bolt UXP, `vite-uxp-plugin/src/ccx.ts` (сборка `.ccx`): https://github.com/hyperbrew/bolt-uxp/blob/main/vite-uxp-plugin/src/ccx.ts
- [52] Bolt UXP, README (UDT через CC, Developer Mode, UPIA): https://github.com/hyperbrew/bolt-uxp
- [53] Форум Adobe, «Build CCX File from the Command Line» (2022): https://forums.creativeclouddeveloper.com/t/build-ccx-file-from-the-command-line/4120
- [54] Adobe, «Debugging UXP Plugins»: https://developer.adobe.com/photoshop/uxp/2022/guides/debugging/
- [55] Node.js, встроенный тест-раннер: https://nodejs.org/api/test.html
- [56] Adobe, «UXP scripts in UDT» (расположение UXPLogs): https://developer.adobe.com/indesign/uxp/scripts/tutorials/debug/
- [57] Форум Adobe, «Photoshop 27.9.1 — Packaged UXP plugin (.ccx) fails to install…» (2026): https://forums.creativeclouddeveloper.com/t/photoshop-27-9-1-packaged-uxp-plugin-ccx-fails-to-install-couldnt-install-plugin-compatible-app-required-premiere-fine-dev-mode-fine/12089
- [58] GitHub, uxp-photoshop-plugin-samples, issue #99 (2026): https://github.com/AdobeDocs/uxp-photoshop-plugin-samples/issues/99
- [59] Adobe, «Getting Started with UXP for Photoshop»: https://developer.adobe.com/photoshop/uxp/2022/guides/
