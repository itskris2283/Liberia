pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ============================
// DATABASE (IndexedDB)
// ============================
class BookDB {
    constructor() {
        this.dbName = 'BookShelfDB';
        this.version = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, this.version);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('books')) {
                    const store = db.createObjectStore('books', { keyPath: 'id' });
                    store.createIndex('lastRead', 'lastRead', { unique: false });
                }
                if (!db.objectStoreNames.contains('bookmarks')) {
                    db.createObjectStore('bookmarks', { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = (e) => reject(e);
        });
    }

    async addBook(book) { return this._tx('books', 'readwrite', s => s.put(book)); }
    async getBook(id) { return this._tx('books', 'readonly', s => s.get(id)); }
    async getAllBooks() { return this._tx('books', 'readonly', s => s.getAll()); }
    async deleteBook(id) { return this._tx('books', 'readwrite', s => s.delete(id)); }
    async clearBooks() { return this._tx('books', 'readwrite', s => s.clear()); }
    async addBookmark(bm) { return this._tx('bookmarks', 'readwrite', s => s.put(bm)); }
    async getBookmarks() { return this._tx('bookmarks', 'readonly', s => s.getAll()); }
    async deleteBookmark(id) { return this._tx('bookmarks', 'readwrite', s => s.delete(id)); }
    async clearBookmarks() { return this._tx('bookmarks', 'readwrite', s => s.clear()); }

    _tx(storeName, mode, fn) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const req = fn(store);
            if (req && req.onsuccess !== undefined) {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } else {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            }
        });
    }
}

// ============================
// APP
// ============================
class BookShelfApp {
    constructor() {
        this.db = new BookDB();
        this.books = [];
        this.bookmarks = [];
        this.currentView = 'library';

        // Reader state
        this.pdf = null;
        this.renderedPages = new Map();
        this.pageRenderPromises = new Map();
        this.totalPages = 0;
        this.currentSpread = 0;
        this.currentBookId = null;
        this.isFlipping = false;
        this.baseW = 0;
        this.baseH = 0;
        this.displayW = 0;
        this.displayH = 0;
        this.hudTimer = null;
        this.isLockedImmersive = false;
        this.wheelCooldown = false;

        this.settings = this.loadSettings();

        this.init();
    }

    async init() {
        await this.db.init();
        this.books = await this.db.getAllBooks() || [];
        this.bookmarks = await this.db.getBookmarks() || [];

        this.cacheDom();
        this.bindEvents();
        this.applyTheme(this.settings.theme);
        this.renderLibrary();
        this.renderRecent();
        this.renderBookmarks();
        this.applySettingsUI();
    }

    loadSettings() {
        const defaults = {
            theme: 'dark',
            animation: 'flip',
            speed: 700,
            spread: true,
            pageNumbers: true,
            zoom: 1,
            invertPages: false
        };
        try {
            const saved = JSON.parse(localStorage.getItem('bookshelf_settings'));
            return { ...defaults, ...saved };
        } catch {
            return defaults;
        }
    }

    saveSettings() {
        localStorage.setItem('bookshelf_settings', JSON.stringify(this.settings));
    }

    cacheDom() {
        this.el = {};
        document.querySelectorAll('[id]').forEach(el => {
            this.el[el.id.replace(/-/g, '_')] = el;
        });
    }

    bindEvents() {
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.view) {
                    this.switchView(btn.dataset.view);
                }
            });
        });

        const mobileAddBtn = document.getElementById('btn-mobile-add-book');
        if (mobileAddBtn) {
            mobileAddBtn.addEventListener('click', () => this.el.file_input_side.click());
        }

        this.el.file_input_main.addEventListener('change', e => this.handleFile(e));
        this.el.file_input_side.addEventListener('change', e => this.handleFile(e));
        this.el.btn_add_book.addEventListener('click', () => this.el.file_input_side.click());

        this.el.search_input.addEventListener('input', e => {
            if (e.target.value.trim() !== '') {
                // Open modal and pass search
                if (this.el.all_books_modal) this.el.all_books_modal.classList.add('active');
                if (this.el.books_grid) this.el.books_grid.style.display = 'grid';
                if (this.el.modal_search_input) {
                    this.el.modal_search_input.value = e.target.value;
                    this.el.modal_search_input.focus();
                }
                this.filterLibrary(e.target.value);
                e.target.value = ''; // clear main search input
            }
        });

        if (this.el.btn_view_all) {
            this.el.btn_view_all.addEventListener('click', () => {
                if (this.el.all_books_modal) this.el.all_books_modal.classList.add('active');
                if (this.el.books_grid) this.el.books_grid.style.display = 'grid';
                if (this.el.modal_search_input) {
                    this.el.modal_search_input.value = '';
                    this.el.modal_search_input.focus();
                }
                this.filterLibrary('');
            });
        }
        
        if (this.el.btn_close_modal) {
            this.el.btn_close_modal.addEventListener('click', () => {
                if (this.el.all_books_modal) this.el.all_books_modal.classList.remove('active');
                this.filterLibrary('');
            });
        }
        
        if (this.el.all_books_modal) {
            this.el.all_books_modal.addEventListener('click', (e) => {
                if (e.target === this.el.all_books_modal) {
                    this.el.all_books_modal.classList.remove('active');
                    this.filterLibrary('');
                }
            });
        }
        
        if (this.el.modal_search_input) {
            this.el.modal_search_input.addEventListener('input', e => this.filterLibrary(e.target.value));
        }

        if (this.el.btn_scroll_right) {
            this.el.btn_scroll_right.addEventListener('click', () => {
                this.el.recently_added_list.scrollBy({ left: 300, behavior: 'smooth' });
            });
        }

        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.settings.theme = btn.dataset.theme;
                this.applyTheme(btn.dataset.theme);
                this.saveSettings();
            });
        });

        this.el.setting_animation.addEventListener('change', e => {
            this.settings.animation = e.target.value;
            this.saveSettings();
        });

        this.el.setting_speed.addEventListener('input', e => {
            this.settings.speed = parseInt(e.target.value);
            this.el.speed_label.textContent = e.target.value + 'ms';
            this.saveSettings();
        });

        this.el.setting_spread.addEventListener('change', e => {
            this.settings.spread = e.target.checked;
            this.saveSettings();
        });

        this.el.setting_page_numbers.addEventListener('change', e => {
            this.settings.pageNumbers = e.target.checked;
            this.saveSettings();
        });

        if (this.el.setting_invert_pages) {
            this.el.setting_invert_pages.addEventListener('change', e => {
                this.settings.invertPages = e.target.checked;
                this.saveSettings();
                this.applySettingsUI();
            });
        }
        
        if (this.el.qs_setting_invert) {
            this.el.qs_setting_invert.addEventListener('change', e => {
                this.settings.invertPages = e.target.checked;
                this.saveSettings();
                this.applySettingsUI();
            });
        }

        this.el.btn_clear_library.addEventListener('click', () => this.clearLibrary());

        this.el.btn_close_reader.addEventListener('click', () => this.closeReader());
        this.el.btn_reader_fullscreen.addEventListener('click', () => this.toggleFullscreen());
        this.el.btn_toc.addEventListener('click', () => this.togglePanel('toc_panel'));
        this.el.btn_bookmark.addEventListener('click', () => this.toggleBookmark());
        this.el.btn_search_reader.addEventListener('click', () => this.togglePanel('search_panel'));
        this.el.btn_reader_settings.addEventListener('click', () => this.togglePanel('quick_settings_panel'));

        document.querySelectorAll('.panel-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const panelId = btn.dataset.close.replace(/-/g, '_');
                this.el[panelId].classList.remove('open');
            });
        });

        document.querySelectorAll('.qs-theme').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.qs-theme').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.settings.theme = btn.dataset.rtheme;
                this.applyTheme(btn.dataset.rtheme);
                this.saveSettings();
            });
        });

        document.querySelectorAll('.qs-view').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.qs-view').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.settings.spread = btn.dataset.rview === 'spread';
                this.saveSettings();
                this.layoutReader();
            });
        });


        if (this.el.reader_zoom_input) {
            this.el.reader_zoom_input.addEventListener('input', e => {
                this.settings.zoom = parseFloat(e.target.value);
                document.documentElement.style.setProperty('--pdf-zoom', this.settings.zoom);
                this.saveSettings();
            });
        }

        this.el.rclick_right.addEventListener('click', () => this.nextPage());
        this.el.rclick_left.addEventListener('click', () => this.prevPage());

        this.el.reader_progress_input.addEventListener('input', e => {
            this.jumpToPage(parseInt(e.target.value));
        });

        this.el.btn_search_go.addEventListener('click', () => this.searchInBook());
        this.el.reader_search_input.addEventListener('keydown', e => {
            if (e.key === 'Enter') this.searchInBook();
        });

        document.addEventListener('keydown', e => this.handleKey(e));

        document.addEventListener('wheel', e => {
            if (!this.el.reader.classList.contains('open')) return;
            if (e.target.closest('.side-panel')) return; // Allow normal scrolling inside side panels
            e.preventDefault();
            if (this.wheelCooldown) return;
            this.wheelCooldown = true;
            setTimeout(() => this.wheelCooldown = false, 400);
            if (e.deltaY > 0) this.nextPage();
            else if (e.deltaY < 0) this.prevPage();
        }, { passive: false });

        let ts = { x: 0, y: 0 };
        document.addEventListener('touchstart', e => {
            ts.x = e.changedTouches[0].screenX;
            ts.y = e.changedTouches[0].screenY;
        }, { passive: true });

        document.addEventListener('touchend', e => {
            if (!this.el.reader.classList.contains('active') && !this.el.reader.classList.contains('open')) return;
            const dx = e.changedTouches[0].screenX - ts.x;
            if (Math.abs(dx) > 60) {
                this.justSwiped = true;
                setTimeout(() => this.justSwiped = false, 300);
                if (dx < 0) this.nextPage();
                else this.prevPage();
            }
        }, { passive: true });

        document.addEventListener('mousemove', () => {
            if (!this.el.reader.classList.contains('open')) return;
            
            this.el.reader.style.cursor = 'default';
            
            if (this.isLockedImmersive) {
                this.el.btn_unlock_immersive.classList.add('visible');
            } else {
                this.showReaderHud();
            }
            
            clearTimeout(this.hudTimer);
            this.hudTimer = setTimeout(() => {
                if (!this.isLockedImmersive) this.hideReaderHud();
                if (this.el.btn_unlock_immersive) this.el.btn_unlock_immersive.classList.remove('visible');
                if (document.fullscreenElement || document.webkitFullscreenElement || this.isLockedImmersive) {
                    this.el.reader.style.cursor = 'none';
                }
            }, 2500);
        });

        let pointerDownPos = { x: 0, y: 0 };
        this.el.reader.addEventListener('pointerdown', (e) => {
            pointerDownPos.x = e.screenX;
            pointerDownPos.y = e.screenY;
        });

        this.el.reader.addEventListener('pointerup', (e) => {
            if (!this.el.reader.classList.contains('open')) return;
            const dx = Math.abs(e.screenX - pointerDownPos.x);
            const dy = Math.abs(e.screenY - pointerDownPos.y);
            if (dx > 10 || dy > 10) return; // Ignore if it was a swipe/drag

            if (e.target.closest('button') || e.target.closest('.side-panel') || e.target.closest('input')) return;

            if (this.isLockedImmersive) {
                if (this.el.btn_unlock_immersive) {
                    this.el.btn_unlock_immersive.classList.add('visible');
                    clearTimeout(this.unlockBtnTimeout);
                    this.unlockBtnTimeout = setTimeout(() => {
                        if (this.isLockedImmersive && this.el.btn_unlock_immersive) {
                            this.el.btn_unlock_immersive.classList.remove('visible');
                        }
                    }, 3000);
                }
            } else {
                if (this.el.reader_topbar.classList.contains('visible')) {
                    this.hideReaderHud();
                } else {
                    this.showReaderHud();
                    clearTimeout(this.hudTimer);
                    this.hudTimer = setTimeout(() => {
                        if (!this.isLockedImmersive) this.hideReaderHud();
                    }, 3000);
                }
            }
        });

        const onFsChange = () => {
            if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
                if (!this.isLockedImmersive) {
                    this.el.reader.style.cursor = 'default';
                    this.showReaderHud();
                }
            }
        };
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);

        if (this.el.btn_unlock_immersive) {
            this.el.btn_unlock_immersive.addEventListener('click', () => this.toggleLockedImmersive());
        }

        if (this.el.btn_qs_lock) {
            this.el.btn_qs_lock.addEventListener('click', () => {
                this.toggleLockedImmersive();
                if (this.el.quick_settings_panel) {
                    this.el.quick_settings_panel.classList.remove('open');
                }
            });
        }

        window.addEventListener('resize', () => {
            if (this.el.reader.classList.contains('open')) this.layoutReader();
        });

        document.addEventListener('click', () => this.el.context_menu.classList.remove('show'));

        this.el.modal_close.addEventListener('click', () => {
            this.el.modal_overlay.classList.remove('show');
        });
        this.el.modal_overlay.addEventListener('click', e => {
            if (e.target === this.el.modal_overlay) this.el.modal_overlay.classList.remove('show');
        });
    }

    applyInvertPages(invert) {
        if (invert) {
            this.el.reader.classList.add('invert-pages');
        } else {
            this.el.reader.classList.remove('invert-pages');
        }
        this.updateAmbientGlow();
    }

    updateAmbientGlow() {
        if (!this.originalAmbientColor) return;
        let [r, g, b] = this.originalAmbientColor.split(',').map(n => parseInt(n));
        
        if (this.settings.invertPages) {
            r = 255 - r;
            g = 255 - g;
            b = 255 - b;
            
            // If the inverted color is pitch black (e.g. from a white cover), 
            // give it a very faint, warm, "bedside lamp" glow instead so it's not completely dead.
            if (r < 40 && g < 40 && b < 40) {
                r = 50; g = 40; b = 30;
            }
        }
        
        document.documentElement.style.setProperty('--ambient-rgb', `${r}, ${g}, ${b}`);
    }

    handleKey(e) {
        if (this.el.reader.classList.contains('open')) {
            switch (e.key) {
                case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown':
                    e.preventDefault(); this.nextPage(); break;
                case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
                    e.preventDefault(); this.prevPage(); break;
                case 'Home': e.preventDefault(); this.jumpToPage(0); break;
                case 'End': e.preventDefault(); this.jumpToPage(this.totalPages - 1); break;
                case 'Escape':
                    e.preventDefault();
                    if (document.querySelector('.side-panel.open')) {
                        this.closePanels();
                    } else {
                        this.closeReader();
                    }
                    break;
                case 'f': case 'F': case 'i': case 'I': if (!e.ctrlKey) { e.preventDefault(); this.toggleFullscreen(); } break;
                case 'l': case 'L': if (!e.ctrlKey) { e.preventDefault(); this.toggleLockedImmersive(); } break;
                case 'b': case 'B': if (!e.ctrlKey) { e.preventDefault(); this.toggleBookmark(); } break;
            }
        }
    }

    switchView(view) {
        this.currentView = view;
        document.querySelectorAll('.nav-item').forEach(n => {
            if (n.dataset.view) n.classList.remove('active');
        });
        document.querySelectorAll(`.nav-item[data-view="${view}"]`).forEach(n => n.classList.add('active'));

        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        this.el[`view_${view}`].classList.add('active');

        if (view === 'bookmarks') this.renderBookmarks();
        if (view === 'recent') this.renderRecent();
    }

    applyTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        document.querySelectorAll('.theme-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.theme === theme);
        });
        document.querySelectorAll('.qs-theme').forEach(b => {
            b.classList.toggle('active', b.dataset.rtheme === theme);
        });
    }

    applySettingsUI() {
        this.el.setting_animation.value = this.settings.animation;
        this.el.setting_speed.value = this.settings.speed;
        this.el.speed_label.textContent = this.settings.speed + 'ms';
        this.el.setting_spread.checked = this.settings.spread;
        this.el.setting_page_numbers.checked = this.settings.pageNumbers;

        if (this.el.setting_invert_pages) this.el.setting_invert_pages.checked = this.settings.invertPages;
        if (this.el.qs_setting_invert) this.el.qs_setting_invert.checked = this.settings.invertPages;
        this.applyInvertPages(this.settings.invertPages);

        if (this.el.reader_zoom_input) {
            this.el.reader_zoom_input.value = this.settings.zoom || 1;
            document.documentElement.style.setProperty('--pdf-zoom', this.settings.zoom || 1);
        }

        document.querySelectorAll('.qs-view').forEach(b => {
            b.classList.toggle('active',
                (b.dataset.rview === 'spread') === this.settings.spread);
        });
    }

    async handleFile(e) {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';

        this.showLoading('Adding book...');

        try {
            const storedData = file.slice(0, file.size, file.type || 'application/pdf');
            const pdfBytes = await storedData.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes.slice(0)) }).promise;

            let cover;
            try {
                cover = await this.generateCover(pdf);
            } catch (coverErr) {
                console.warn('Cover generation failed', coverErr);
                cover = this.getFallbackCover(file.name);
            }

            let outline = [];
            try {
                outline = this.parseOutline(await pdf.getOutline());
            } catch (outlineErr) {
                console.warn('Outline extraction failed', outlineErr);
            }

            let metaTitle = file.name.replace(/\.pdf$/i, '');
            let metaAuthor = 'Unknown';
            try {
                const meta = await pdf.getMetadata();
                if (meta && meta.info) {
                    if (meta.info.Title && meta.info.Title.trim() !== '') metaTitle = meta.info.Title;
                    if (meta.info.Author && meta.info.Author.trim() !== '') metaAuthor = meta.info.Author;
                }
            } catch (metaErr) {
                console.warn('Metadata extraction failed', metaErr);
            }

            const id = 'book_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            const book = {
                id,
                title: metaTitle,
                author: metaAuthor,
                fileName: file.name,
                pages: pdf.numPages,
                data: new Blob([pdfBytes], { type: file.type || 'application/pdf' }),
                cover,
                outline,
                currentPage: 0,
                lastRead: Date.now(),
                addedAt: Date.now(),
                progress: 0,
                persisted: false
            };

            const existingIdx = this.books.findIndex(b => b.fileName === file.name);
            if (existingIdx !== -1) {
                try {
                    await this.db.deleteBook(this.books[existingIdx].id);
                } catch (e) {
                    console.warn('Could not delete old book version', e);
                }
                this.books.splice(existingIdx, 1);
            }

            try {
                await this.db.addBook(book);
                book.persisted = true;
            } catch (persistErr) {
                console.warn('Could not persist book to IndexedDB', persistErr);
            }
            this.books.push(book);

            this.hideLoading();
            this.renderLibrary();
            this.renderRecent();
            this.toast(book.persisted ? `"${book.title}" added to library` : `"${book.title}" added for this session`);

        } catch (err) {
            console.error(err);
            this.hideLoading();
            this.toast('Failed to add book');
        }
    }

    async generateCover(pdf) {
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        return canvas.toDataURL('image/jpeg', 0.7);
    }

    getFallbackCover(title) {
        const safeTitle = String(title || 'Book').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720">
                <defs>
                    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0%" stop-color="#3a2a1c" />
                        <stop offset="100%" stop-color="#14110e" />
                    </linearGradient>
                </defs>
                <rect width="480" height="720" fill="url(#g)"/>
                <rect x="36" y="36" width="408" height="648" rx="24" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/>
                <text x="50%" y="46%" fill="#f5e9d8" font-family="Arial, sans-serif" font-size="34" text-anchor="middle">${safeTitle}</text>
                <text x="50%" y="54%" fill="rgba(245,233,216,0.78)" font-family="Arial, sans-serif" font-size="18" text-anchor="middle">PDF Book</text>
            </svg>
        `);
    }

    async extractAmbientColor(coverDataUrl) {
        if (!coverDataUrl || coverDataUrl.startsWith('data:image/svg')) return '80, 60, 30';
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 10;
                canvas.height = 10;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 10, 10);
                const data = ctx.getImageData(0, 0, 10, 10).data;
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < data.length; i += 4) {
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                }
                const count = data.length / 4;
                resolve(`${Math.round(r/count)}, ${Math.round(g/count)}, ${Math.round(b/count)}`);
            };
            img.onerror = () => resolve('80, 60, 30');
            img.src = coverDataUrl;
        });
    }

    parseOutline(outline) {
        if (!outline) return [];
        return outline.map(item => ({
            title: item.title,
            dest: item.dest
        }));
    }

    renderLibrary() {
        const grid = this.el.books_grid;
        const empty = this.el.empty_library;

        if (grid) grid.innerHTML = '';
        if (this.el.recently_added_list) this.el.recently_added_list.innerHTML = '';

        if (this.books.length === 0) {
            if (empty) empty.style.display = 'flex';
            if (this.el.hero_section) this.el.hero_section.style.display = 'none';
            if (this.el.recently_added_section) this.el.recently_added_section.style.display = 'none';
            this.updateDashboardStats();
            return;
        }

        if (empty) empty.style.display = 'none';
        
        const sortedByRecent = [...this.books].sort((a, b) => (b.lastRead || b.addedAt) - (a.lastRead || a.addedAt));
        const heroBook = sortedByRecent[0];
        
        if (heroBook && this.el.hero_section) {
            this.el.hero_section.style.display = 'flex';
            this.el.hero_title.textContent = heroBook.title;
            this.el.hero_author.textContent = heroBook.author || 'Unknown Author';
            this.el.hero_cover.src = heroBook.cover;
            const pct = heroBook.progress || 0;
            this.el.hero_progress_pct.textContent = `${Math.round(pct)}% complete`;
            const curPage = heroBook.currentPage || 0;
            this.el.hero_progress_pages.textContent = `${curPage} / ${heroBook.pages} pages`;
            this.el.hero_progress_fill.style.width = `${pct}%`;
            
            const newContinueBtn = this.el.btn_hero_continue.cloneNode(true);
            this.el.btn_hero_continue.parentNode.replaceChild(newContinueBtn, this.el.btn_hero_continue);
            this.el.btn_hero_continue = newContinueBtn;
            this.el.btn_hero_continue.addEventListener('click', () => this.openBook(heroBook.id));
        }

        const sortedByAdded = [...this.books].sort((a, b) => b.addedAt - a.addedAt);
        const recentlyAddedList = this.el.recently_added_list;
        
        if (recentlyAddedList && this.el.recently_added_section) {
            this.el.recently_added_section.style.display = 'flex';
            
            sortedByAdded.slice(0, 10).forEach(book => {
                const card = document.createElement('div');
                card.className = 'book-card';
                card.innerHTML = `
                    <div class="book-cover">
                        <img src="${book.cover}" alt="">
                        <div class="book-badge" style="position:absolute; top:8px; right:8px; background:rgba(0,0,0,0.8); padding:2px 6px; border-radius:12px; font-size:0.75rem; color:#fff;">${Math.round(book.progress || 0)}%</div>
                    </div>
                    <div class="book-card-info">
                        <div class="book-card-title">${book.title}</div>
                        <div class="book-card-meta">${book.author || 'Unknown'}</div>
                    </div>
                `;
                card.addEventListener('click', () => this.openBook(book.id));
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showContextMenu(e, book.id);
                });
                recentlyAddedList.appendChild(card);
            });
        }

        if (grid) {
            sortedByAdded.forEach(book => {
                const card = document.createElement('div');
                card.className = 'book-card';
                card.innerHTML = `
                    <div class="book-cover">
                        <img src="${book.cover}" alt="">
                        <div class="book-cover-overlay">
                            <div class="book-progress-bar">
                                <div class="book-progress-bar-fill" style="width:${book.progress || 0}%"></div>
                            </div>
                        </div>
                    </div>
                    <div class="book-card-info">
                        <div class="book-card-title">${book.title}</div>
                        <div class="book-card-meta">${book.pages} pages${book.progress ? ' · ' + Math.round(book.progress) + '%' : ''}</div>
                    </div>
                `;

                card.addEventListener('click', () => this.openBook(book.id));
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showContextMenu(e, book.id);
                });

                grid.appendChild(card);
            });
        }
        
        this.updateDashboardStats();
    }

    updateDashboardStats() {
        if (!this.el.overall_progress_text) return;
        
        let totalPages = 0;
        let totalReadPages = 0;
        let completedBooks = 0;

        this.books.forEach(b => {
            totalPages += (b.pages || 0);
            totalReadPages += (b.currentPage || 0);
            if (b.progress >= 95) completedBooks++;
        });

        const overallPct = totalPages > 0 ? Math.round((totalReadPages / totalPages) * 100) : 0;
        
        this.el.overall_progress_text.textContent = `${overallPct}%`;
        this.el.stat_books_read.textContent = completedBooks;
        this.el.stat_pages_read.textContent = totalReadPages.toLocaleString();

        const dashArray = `${overallPct}, 100`;
        if (this.el.overall_progress_circle) {
            this.el.overall_progress_circle.setAttribute('stroke-dasharray', dashArray);
        }

        this.updateStreak();
    }

    updateStreak() {
        if (!this.el.streak_count) return;
        
        const streak = this.settings.streak || { count: 0, lastDate: null };
        this.el.streak_count.textContent = streak.count; 
        
        if (this.el.streak_days) {
            const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
            this.el.streak_days.innerHTML = '';
            
            const today = new Date();
            let todayIdx = today.getDay() - 1;
            if (todayIdx === -1) todayIdx = 6;

            const todayStr = today.toISOString().split('T')[0];
            const hasReadToday = streak.lastDate === todayStr;
            
            const streakEndIdx = hasReadToday ? todayIdx : todayIdx - 1;
            const streakStartIdx = streakEndIdx - streak.count + 1;
            
            days.forEach((day, i) => {
                const isActive = (i >= streakStartIdx && i <= streakEndIdx);
                this.el.streak_days.innerHTML += `
                    <div class="streak-day">
                        <span>${day}</span>
                        <div class="streak-check ${isActive ? 'active' : ''}">✓</div>
                    </div>
                `;
            });
        }

        this.updateQuote();
    }

    updateQuote() {
        if (!this.el.quote_text || !this.el.quote_author) return;

        const quotes = [
            { text: "A book is a dream that you hold in your hands.", author: "Neil Gaiman" },
            { text: "There is no friend as loyal as a book.", author: "Ernest Hemingway" },
            { text: "Reading is to the mind what exercise is to the body.", author: "Joseph Addison" },
            { text: "To learn to read is to light a fire; every syllable that is spelled out is a spark.", author: "Victor Hugo" },
            { text: "A room without books is like a body without a soul.", author: "Cicero" },
            { text: "So many books, so little time.", author: "Frank Zappa" },
            { text: "I have always imagined that Paradise will be a kind of library.", author: "Jorge Luis Borges" },
            { text: "We read to know we are not alone.", author: "C.S. Lewis" },
            { text: "A reader lives a thousand lives before he dies. The man who never reads lives only one.", author: "George R.R. Martin" },
            { text: "Until I feared I would lose it, I never loved to read. One does not love breathing.", author: "Harper Lee" },
            { text: "You can never get a cup of tea large enough or a book long enough to suit me.", author: "C.S. Lewis" },
            { text: "If you don’t like to read, you haven’t found the right book.", author: "J.K. Rowling" },
            { text: "Books are a uniquely portable magic.", author: "Stephen King" },
            { text: "The more that you read, the more things you will know. The more that you learn, the more places you'll go.", author: "Dr. Seuss" },
            { text: "Books are the mirrors of the soul.", author: "Virginia Woolf" },
            { text: "Think before you speak. Read before you think.", author: "Fran Lebowitz" },
            { text: "Let us read, and let us dance; these two amusements will never do any harm to the world.", author: "Voltaire" },
            { text: "Books are the plane, and the train, and the road. They are the destination, and the journey. They are home.", author: "Anna Quindlen" },
            { text: "The library is inhabited by spirits that come out of the pages at night.", author: "Isabel Allende" },
            { text: "Sleep is good, he said, and books are better.", author: "George R.R. Martin" },
            { text: "Reading is a discount ticket to everywhere.", author: "Mary Schmich" },
            { text: "A book is a device to ignite the imagination.", author: "Alan Bennett" },
            { text: "Show me a family of readers, and I will show you the people who move the world.", author: "Napoléon Bonaparte" },
            { text: "Books are the quietest and most constant of friends; they are the most accessible and wisest of counselors.", author: "Charles W. Eliot" },
            { text: "That’s the thing about books. They let you travel without moving your feet.", author: "Jhumpa Lahiri" },
            { text: "Read, read, read. Read everything—trash, classics, good and bad, and see how they do it.", author: "William Faulkner" },
            { text: "Books are not made for furniture, but there is nothing else that so beautifully furnishes a house.", author: "Henry Ward Beecher" },
            { text: "Once you learn to read, you will be forever free.", author: "Frederick Douglass" },
            { text: "In the case of good books, the point is not to see how many of them you can get through, but rather how many can get through to you.", author: "Mortimer J. Adler" },
            { text: "We lose ourselves in books, we find ourselves there too.", author: "Anonymous" },
            { text: "A book is a garden, an orchard, a storehouse, a party, a company by the way, a counselor, a multitude of counselors.", author: "Charles Baudelaire" }
        ];

        // Pick quote based on day of year
        const now = new Date();
        const start = new Date(now.getFullYear(), 0, 0);
        const diff = now - start;
        const oneDay = 1000 * 60 * 60 * 24;
        const dayOfYear = Math.floor(diff / oneDay);
        
        const q = quotes[dayOfYear % quotes.length];
        this.el.quote_text.textContent = q.text;
        this.el.quote_author.textContent = `— ${q.author}`;
    }

    recordReadingSession() {
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        let streak = this.settings.streak || { count: 0, lastDate: null };

        if (streak.lastDate !== todayStr) {
            if (streak.lastDate) {
                const lastDate = new Date(streak.lastDate);
                const diffTime = Math.abs(now - lastDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                
                if (diffDays === 1) {
                    streak.count += 1;
                } else if (diffDays > 1) {
                    streak.count = 1;
                }
            } else {
                streak.count = 1;
            }
            streak.lastDate = todayStr;
            this.settings.streak = streak;
            this.saveSettings();
            this.updateStreak();
        }
    }

    filterLibrary(query) {
        const q = query.toLowerCase().trim();

        const cards = this.el.books_grid.querySelectorAll('.book-card');
        cards.forEach(card => {
            const title = card.querySelector('.book-card-title').textContent.toLowerCase();
            const author = card.querySelector('.book-card-meta').textContent.toLowerCase();
            card.style.display = (title.includes(q) || author.includes(q)) ? '' : 'none';
        });
    }

    renderRecent() {
        const list = this.el.recent_list;
        const empty = this.el.empty_recent;

        const recent = [...this.books]
            .filter(b => b.lastRead)
            .sort((a, b) => b.lastRead - a.lastRead)
            .slice(0, 20);

        list.innerHTML = '';

        if (recent.length === 0) {
            empty.classList.add('show');
            return;
        }

        empty.classList.remove('show');

        recent.forEach(book => {
            const item = document.createElement('div');
            item.className = 'book-list-item';
            item.innerHTML = `
                <div class="book-list-thumb">
                    <img src="${book.cover}" alt="">
                </div>
                <div class="book-list-info">
                    <div class="book-list-title">${book.title}</div>
                    <div class="book-list-meta">${this.timeAgo(book.lastRead)} · Page ${(book.currentPage || 0) + 1}</div>
                </div>
                <div class="book-list-progress">
                    <div class="book-list-progress-fill" style="width:${book.progress || 0}%"></div>
                </div>
            `;
            item.addEventListener('click', () => this.openBook(book.id));
            list.appendChild(item);
        });
    }

    renderBookmarks() {
        const list = this.el.bookmarks_list;
        const empty = this.el.empty_bookmarks;

        list.innerHTML = '';

        if (this.bookmarks.length === 0) {
            empty.classList.add('show');
            return;
        }

        empty.classList.remove('show');

        this.bookmarks.forEach(bm => {
            const item = document.createElement('div');
            item.className = 'bookmark-item';
            item.innerHTML = `
                <span class="bookmark-icon">🔖</span>
                <div class="bookmark-info">
                    <div class="bookmark-title">${bm.bookTitle}</div>
                    <div class="bookmark-page">Page ${bm.page + 1}</div>
                </div>
                <button class="bookmark-remove" data-id="${bm.id}">✕</button>
            `;

            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('bookmark-remove')) return;
                this.openBook(bm.bookId, bm.page);
            });

            item.querySelector('.bookmark-remove').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.db.deleteBookmark(bm.id);
                this.bookmarks = this.bookmarks.filter(b => b.id !== bm.id);
                this.renderBookmarks();
                this.toast('Bookmark removed');
            });

            list.appendChild(item);
        });
    }

    showContextMenu(e, bookId) {
        const menu = this.el.context_menu;
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.add('show');

        const newMenu = menu.cloneNode(true);
        menu.parentNode.replaceChild(newMenu, menu);
        this.el.context_menu = newMenu;

        newMenu.querySelectorAll('.cm-item').forEach(item => {
            item.addEventListener('click', () => {
                newMenu.classList.remove('show');
                switch (item.dataset.action) {
                    case 'open': this.openBook(bookId); break;
                    case 'info': this.showBookInfo(bookId); break;
                    case 'delete': this.deleteBook(bookId); break;
                }
            });
        });
    }

    showBookInfo(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book) return;

        this.el.modal_body.innerHTML = `
            <p><strong>Title:</strong> ${book.title}</p>
            <p><strong>File:</strong> ${book.fileName}</p>
            <p><strong>Pages:</strong> ${book.pages}</p>
            <p><strong>Added:</strong> ${new Date(book.addedAt).toLocaleDateString()}</p>
            <p><strong>Last Read:</strong> ${book.lastRead ? new Date(book.lastRead).toLocaleDateString() : 'Never'}</p>
            <p><strong>Progress:</strong> ${Math.round(book.progress || 0)}%</p>
        `;

        this.el.modal_overlay.classList.add('show');
    }

    async deleteBook(bookId) {
        if (!confirm('Remove this book from your library?')) return;
        
        try {
            await this.db.deleteBook(bookId);
        } catch (e) {
            console.warn('Could not delete from DB', e);
        }

        this.books = this.books.filter(b => b.id !== bookId);
        this.renderLibrary();
        this.renderRecent();
        this.toast('Book removed');
    }

    async clearLibrary() {
        if (!confirm('Clear entire library? This cannot be undone.')) return;
        await this.db.clearBooks();
        await this.db.clearBookmarks();
        this.books = [];
        this.bookmarks = [];
        this.renderLibrary();
        this.renderRecent();
        this.renderBookmarks();
        this.toast('Library cleared');
    }

    async openBook(bookId, startPage) {
        if (this.el.all_books_modal) {
            this.el.all_books_modal.classList.remove('active');
        }
        const book = this.books.find(b => b.id === bookId);
        if (!book) return;

        this.recordReadingSession();

        this.showLoading('Opening book...');

        try {
            let data;
            if (book.data instanceof Blob) {
                data = new Uint8Array(await book.data.arrayBuffer());
            } else if (book.data instanceof ArrayBuffer) {
                data = new Uint8Array(book.data);
            } else if (ArrayBuffer.isView(book.data)) {
                data = new Uint8Array(book.data.buffer, book.data.byteOffset, book.data.byteLength);
            } else {
                data = new Uint8Array(book.data);
            }
            this.pdf = await pdfjsLib.getDocument({ data }).promise;
            this.totalPages = this.pdf.numPages;
            this.currentBookId = bookId;
            this.renderedPages.clear();
            this.pageRenderPromises.clear();

            const p1 = await this.pdf.getPage(1);
            const vp = p1.getViewport({ scale: 1 });
            this.baseW = vp.width;
            this.baseH = vp.height;

            const sp = startPage !== undefined ? startPage : (book.currentPage || 0);
            this.currentSpread = this.settings.spread
                ? Math.floor(sp / 2) * 2
                : sp;

            this.el.reader_progress_input.max = this.totalPages - 1;
            this.el.reader_title.textContent = book.title;
            this.renderToc(book.outline);

            await this.preloadPageRange(this.currentSpread + 1, this.settings.spread ? this.currentSpread + 4 : this.currentSpread + 2);

            book.lastRead = Date.now();
            if (book.persisted) {
                await this.db.addBook(book);
            }

            this.originalAmbientColor = await this.extractAmbientColor(book.cover);
            this.updateAmbientGlow();

            this.el.reader.classList.add('open');
            this.el.sidebar.style.display = 'none';
            this.el.main_content.style.display = 'none';

            this.hideLoading();
            await this.layoutReader();
            this.showReaderHud();
            setTimeout(() => this.hideReaderHud(), 3000);

        } catch (err) {
            console.error(err);
            this.hideLoading();
            this.toast('Failed to open book: ' + (err.message || err.toString()));
        }
    }

    async renderPdfPage(num) {
        return this.ensurePageRendered(num);
    }

    async ensurePageRendered(num) {
        if (num < 1 || num > this.totalPages || !this.pdf) return null;
        if (this.renderedPages.has(num)) return this.renderedPages.get(num);
        if (this.pageRenderPromises.has(num)) return this.pageRenderPromises.get(num);

        const renderPromise = (async () => {
            const page = await this.pdf.getPage(num);
            const scale = 2.5;
            const vp = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            this.renderedPages.set(num, canvas);
            return canvas;
        })().finally(() => {
            this.pageRenderPromises.delete(num);
        });

        this.pageRenderPromises.set(num, renderPromise);
        return renderPromise;
    }

    async preloadPageRange(startPage, endPage) {
        if (!this.pdf) return;
        const first = Math.max(1, Math.min(startPage, endPage));
        const last = Math.min(this.totalPages, Math.max(startPage, endPage));
        const promises = [];

        for (let pageNum = first; pageNum <= last; pageNum++) {
            promises.push(this.ensurePageRendered(pageNum).catch(() => null));
        }

        await Promise.all(promises);
    }

    // ============================================
    // LAYOUT — BOOK FILLS ENTIRE SCREEN
    // ============================================
    async layoutReader() {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const ratio = this.baseW / this.baseH;
        const isPortrait = vh > vw;
        const isSpread = this.settings.spread && vw > 900 && !isPortrait;

        document.querySelectorAll('.qs-view').forEach(b => {
            b.classList.toggle('active', (b.dataset.rview === 'spread') === isSpread);
        });

        // MINIMAL padding - book fills nearly entire screen
        const padV = isPortrait ? 0 : 20;
        const padH = isPortrait ? 0 : 30;

        const availableH = vh - (padV * 2);
        const availableW = vw - (padH * 2);

        if (isSpread) {
            this.el.single_page_view.classList.remove('active');
            this.el.spread_view.classList.add('active');

            // Account for spine (10px) and page edges (~24px)
            const spineAndEdges = 34;

            // Fit by height first
            let pageH = availableH;
            let pageW = pageH * ratio;

            // Constrain by width if needed
            if ((pageW * 2 + spineAndEdges) > availableW) {
                pageW = (availableW - spineAndEdges) / 2;
                pageH = pageW / ratio;
            }

            pageW = Math.floor(pageW);
            pageH = Math.floor(pageH);
            this.displayW = pageW;
            this.displayH = pageH;

            this.el.r_left_page.style.width = pageW + 'px';
            this.el.r_left_page.style.height = pageH + 'px';
            this.el.r_right_page.style.width = pageW + 'px';
            this.el.r_right_page.style.height = pageH + 'px';
            this.el.r_spine.style.height = pageH + 'px';

            this.currentSpread = Math.floor(this.currentSpread / 2) * 2;

        } else {
            this.el.spread_view.classList.remove('active');
            this.el.single_page_view.classList.add('active');

            let pageH = availableH;
            let pageW = pageH * ratio;

            if (pageW > availableW) {
                pageW = availableW;
                pageH = pageW / ratio;
            }

            pageW = Math.floor(pageW);
            pageH = Math.floor(pageH);
            this.displayW = pageW;
            this.displayH = pageH;

            this.el.sp_page.style.width = pageW + 'px';
            this.el.sp_page.style.height = pageH + 'px';
        }

        await this.drawCurrentView();
    }

    async drawCurrentView() {
        const isSpread = this.el.spread_view.classList.contains('active');

        if (isSpread) {
            const leftNum = this.currentSpread + 1;
            const rightNum = this.currentSpread + 2;

            await Promise.all([
                this.drawInto(this.el.r_left_content, leftNum),
                this.drawInto(this.el.r_right_content, rightNum)
            ]);

            if (this.settings.pageNumbers) {
                this.el.r_left_num.textContent = leftNum <= this.totalPages ? leftNum : '';
                this.el.r_right_num.textContent = rightNum <= this.totalPages ? rightNum : '';
                this.el.r_left_num.style.display = '';
                this.el.r_right_num.style.display = '';
            } else {
                this.el.r_left_num.style.display = 'none';
                this.el.r_right_num.style.display = 'none';
            }

            const prog = this.currentSpread / this.totalPages;
            const lt = Math.max(3, Math.floor(12 * prog));
            const rt = Math.max(3, 12 - lt);
            this.el.r_left_edges.style.width = lt + 'px';
            this.el.r_right_edges.style.width = rt + 'px';
            this.el.r_left_edges.style.display = this.currentSpread === 0 ? 'none' : 'block';
            this.el.r_right_edges.style.display = this.currentSpread + 2 >= this.totalPages ? 'none' : 'block';

        } else {
            const pageNum = this.currentSpread + 1;
            await this.drawInto(this.el.sp_content, pageNum);
        }

        this.updateReaderUI();
    }

    async drawInto(container, pageNum) {
        container.innerHTML = '';
        if (pageNum < 1 || pageNum > this.totalPages) return;

        const src = this.renderedPages.get(pageNum) || await this.ensurePageRendered(pageNum);
        if (!src) return;

        const canvas = document.createElement('canvas');
        canvas.width = this.displayW * 2;
        canvas.height = this.displayH * 2;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
        container.appendChild(canvas);
    }

    makeCanvas(pageNum) {
        const canvas = document.createElement('canvas');
        canvas.width = this.displayW * 2;
        canvas.height = this.displayH * 2;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        return canvas;
    }

    async nextPage() {
        if (this.isFlipping) return;
        const isSpread = this.el.spread_view.classList.contains('active');
        const step = isSpread ? 2 : 1;

        if (this.currentSpread + step >= this.totalPages) return;

        this.isFlipping = true;
        const target = this.currentSpread + step;

        await this.preloadPageRange(target + 1, isSpread ? target + 4 : target + 2);

        await this.animateTurn('forward', target, isSpread);

        this.currentSpread = target;
        this.el.flip_layer.innerHTML = '';
        await this.drawCurrentView();
        this.saveProgress();
        this.isFlipping = false;
    }

    async prevPage() {
        if (this.isFlipping) return;
        const isSpread = this.el.spread_view.classList.contains('active');
        const step = isSpread ? 2 : 1;

        if (this.currentSpread - step < 0) return;

        this.isFlipping = true;
        const target = this.currentSpread - step;

        await this.preloadPageRange(target + 1, isSpread ? target + 4 : target + 2);

        await this.animateTurn('backward', target, isSpread);

        this.currentSpread = target;
        this.el.flip_layer.innerHTML = '';
        await this.drawCurrentView();
        this.saveProgress();
        this.isFlipping = false;
    }

    jumpToPage(pageIndex) {
        if (this.isFlipping) return;
        const isSpread = this.el.spread_view.classList.contains('active');
        const idx = isSpread ? Math.floor(pageIndex / 2) * 2 : pageIndex;
        const clamped = Math.max(0, Math.min(idx, this.totalPages - 1));
        if (clamped === this.currentSpread) return;
        this.currentSpread = clamped;
        this.preloadPageRange(clamped + 1, isSpread ? clamped + 4 : clamped + 2).catch(() => {});
        this.drawCurrentView();
        this.saveProgress();
    }

    animateTurn(direction, target, isSpread) {
        const type = this.settings.animation;
        const speed = this.settings.speed;

        switch (type) {
            case 'flip': return this.flipAnim(direction, target, isSpread, speed);
            case 'slide': return this.slideAnim(direction, speed);
            case 'fade': return this.fadeAnim(speed);
            case 'none': return Promise.resolve();
            default: return this.flipAnim(direction, target, isSpread, speed);
        }
    }

    flipAnim(direction, target, isSpread, speed) {
        return new Promise(resolve => {
            if (!isSpread) {
                return this.singlePageFlip(direction, target, speed, resolve);
            }

            const layer = this.el.flip_layer;
            layer.innerHTML = '';

            if (direction === 'forward') {
                const leaf = document.createElement('div');
                leaf.className = 'flip-leaf from-right';
                leaf.style.width = this.displayW + 'px';
                leaf.style.height = this.displayH + 'px';
                leaf.style.left = `calc(50% + 5px)`;
                leaf.style.transition = `transform ${speed}ms cubic-bezier(0.4, 0.0, 0.2, 1)`;

                const front = document.createElement('div');
                front.className = 'flip-face flip-face-front';
                front.appendChild(this.makeCanvas(this.currentSpread + 2));

                const back = document.createElement('div');
                back.className = 'flip-face flip-face-back';
                back.appendChild(this.makeCanvas(target + 1));

                leaf.appendChild(front);
                leaf.appendChild(back);
                layer.appendChild(leaf);

                const shadow = document.createElement('div');
                shadow.className = 'flip-cast-shadow on-left';
                shadow.style.transition = `opacity ${speed}ms`;
                layer.appendChild(shadow);

                this.drawInto(this.el.r_right_content, target + 2);

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        leaf.style.transform = 'rotateY(-180deg)';
                        shadow.style.opacity = '1';
                        setTimeout(() => {
                            shadow.style.opacity = '0';
                            resolve();
                        }, speed + 50);
                    });
                });

            } else {
                const leaf = document.createElement('div');
                leaf.className = 'flip-leaf from-left';
                leaf.style.width = this.displayW + 'px';
                leaf.style.height = this.displayH + 'px';
                leaf.style.left = '0';
                leaf.style.transition = `transform ${speed}ms cubic-bezier(0.4, 0.0, 0.2, 1)`;

                const front = document.createElement('div');
                front.className = 'flip-face flip-face-front';
                front.appendChild(this.makeCanvas(this.currentSpread + 1));

                const back = document.createElement('div');
                back.className = 'flip-face flip-face-back';
                back.appendChild(this.makeCanvas(target + 2));

                leaf.appendChild(front);
                leaf.appendChild(back);
                layer.appendChild(leaf);

                const shadow = document.createElement('div');
                shadow.className = 'flip-cast-shadow on-right';
                shadow.style.transition = `opacity ${speed}ms`;
                layer.appendChild(shadow);

                this.drawInto(this.el.r_left_content, target + 1);

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        leaf.style.transform = 'rotateY(180deg)';
                        shadow.style.opacity = '1';
                        setTimeout(() => {
                            shadow.style.opacity = '0';
                            resolve();
                        }, speed + 50);
                    });
                });
            }
        });
    }

    singlePageFlip(direction, target, speed, resolve) {
        const layer = this.el.flip_layer;
        layer.innerHTML = '';

        const leaf = document.createElement('div');
        leaf.className = `flip-leaf ${direction === 'forward' ? 'from-right' : 'from-left'}`;
        leaf.style.width = this.displayW + 'px';
        leaf.style.height = this.displayH + 'px';
        leaf.style.left = '0';
        leaf.style.transition = `transform ${speed}ms cubic-bezier(0.4, 0.0, 0.2, 1)`;

        if (direction === 'forward') {
            leaf.style.transformOrigin = 'left center';

            const front = document.createElement('div');
            front.className = 'flip-face flip-face-front';
            front.appendChild(this.makeCanvas(this.currentSpread + 1));

            const back = document.createElement('div');
            back.className = 'flip-face flip-face-back';
            back.appendChild(this.makeCanvas(target + 1));

            leaf.appendChild(front);
            leaf.appendChild(back);
            layer.appendChild(leaf);

            this.drawInto(this.el.sp_content, target + 1);

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    leaf.style.transform = 'rotateY(-180deg)';
                    setTimeout(resolve, speed + 50);
                });
            });

        } else {
            leaf.style.transformOrigin = 'right center';

            const front = document.createElement('div');
            front.className = 'flip-face flip-face-front';
            front.appendChild(this.makeCanvas(this.currentSpread + 1));

            const back = document.createElement('div');
            back.className = 'flip-face flip-face-back';
            back.appendChild(this.makeCanvas(target + 1));

            leaf.appendChild(front);
            leaf.appendChild(back);
            layer.appendChild(leaf);

            this.drawInto(this.el.sp_content, target + 1);

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    leaf.style.transform = 'rotateY(180deg)';
                    setTimeout(resolve, speed + 50);
                });
            });
        }
    }

    slideAnim(direction, speed) {
        return new Promise(resolve => {
            const target = this.el.spread_view.classList.contains('active')
                ? this.el.spread_view
                : this.el.sp_page;

            const outAnim = direction === 'forward' ? 'slide-left-out' : 'slide-right-out';
            const inAnim = direction === 'forward' ? 'slide-left-in' : 'slide-right-in';
            const halfSpeed = speed / 2;

            target.style.animation = `${outAnim} ${halfSpeed}ms ease forwards`;

            setTimeout(() => {
                const isSpread = this.el.spread_view.classList.contains('active');
                const next = direction === 'forward'
                    ? this.currentSpread + (isSpread ? 2 : 1)
                    : this.currentSpread - (isSpread ? 2 : 1);

                if (isSpread) {
                    this.drawInto(this.el.r_left_content, next + 1);
                    this.drawInto(this.el.r_right_content, next + 2);
                } else {
                    this.drawInto(this.el.sp_content, next + 1);
                }

                target.style.animation = `${inAnim} ${halfSpeed}ms ease forwards`;

                setTimeout(() => {
                    target.style.animation = '';
                    resolve();
                }, halfSpeed);
            }, halfSpeed);
        });
    }

    fadeAnim(speed) {
        return new Promise(resolve => {
            const target = this.el.book_display;
            const half = speed / 2;

            target.style.animation = `fade-out ${half}ms ease forwards`;

            setTimeout(() => {
                target.style.animation = `fade-in ${half}ms ease forwards`;
                setTimeout(() => {
                    target.style.animation = '';
                    resolve();
                }, half);
            }, half);
        });
    }

    updateReaderUI() {
        const isSpread = this.el.spread_view.classList.contains('active');
        const left = this.currentSpread + 1;
        const right = isSpread ? Math.min(this.currentSpread + 2, this.totalPages) : left;

        this.el.reader_page_info.textContent = isSpread
            ? `${left}–${right} / ${this.totalPages}`
            : `${left} / ${this.totalPages}`;

        this.el.reader_progress_input.value = this.currentSpread;

        const pct = ((this.currentSpread + (isSpread ? 2 : 1)) / this.totalPages) * 100;
        this.el.reader_progress_fill.style.width = Math.min(100, pct) + '%';
        this.el.reader_percent.textContent = Math.min(100, Math.round(pct)) + '%';

        const remaining = this.totalPages - (this.currentSpread + (isSpread ? 2 : 1));
        this.el.reader_pages_left.textContent = remaining > 0
            ? `${remaining} pages left`
            : 'End of book';

        const isBookmarked = this.bookmarks.some(
            bm => bm.bookId === this.currentBookId && bm.page === this.currentSpread
        );
        this.el.btn_bookmark.textContent = isBookmarked ? '♥' : '♡';
        this.el.btn_bookmark.classList.toggle('bookmarked', isBookmarked);
    }

    showReaderHud() {
        this.el.reader_topbar.classList.add('visible');
        this.el.reader_bottombar.classList.add('visible');
    }

    hideReaderHud() {
        this.el.reader_topbar.classList.remove('visible');
        this.el.reader_bottombar.classList.remove('visible');
    }

    async saveProgress() {
        const book = this.books.find(b => b.id === this.currentBookId);
        if (!book) return;

        book.currentPage = this.currentSpread;
        book.lastRead = Date.now();

        const isSpread = this.el.spread_view.classList.contains('active');
        book.progress = ((this.currentSpread + (isSpread ? 2 : 1)) / this.totalPages) * 100;

        await this.db.addBook(book);
    }

    async closeReader() {
        await this.saveProgress();

        this.el.reader.classList.remove('open');
        this.el.sidebar.style.display = '';
        this.el.main_content.style.display = '';

        this.closePanels();

        this.pdf = null;
        this.renderedPages.clear();
        this.currentBookId = null;

        if (document.fullscreenElement || document.webkitFullscreenElement) {
            try {
                if (document.exitFullscreen) document.exitFullscreen().catch(e=>{});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } catch(e) {}
        }

        this.renderLibrary();
        this.renderRecent();
    }

    renderToc(outline) {
        const list = this.el.toc_list;
        list.innerHTML = '';

        if (!outline || outline.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:10px;">No table of contents available</p>';
            return;
        }

        outline.forEach(item => {
            const div = document.createElement('div');
            div.className = 'toc-item';
            div.textContent = item.title;
            div.addEventListener('click', async () => {
                if (item.dest) {
                    try {
                        let destArray = item.dest;
                        if (typeof item.dest === 'string') {
                            destArray = await this.pdf.getDestination(item.dest);
                        }
                        
                        if (destArray) {
                            const pageIdx = await this.pdf.getPageIndex(destArray[0]);
                            this.jumpToPage(pageIdx);
                            this.el.toc_panel.classList.remove('open');
                        }
                    } catch (err) {
                        console.warn(err);
                        this.toast('Could not navigate to section');
                    }
                }
            });
            list.appendChild(div);
        });
    }

    async searchInBook() {
        const query = this.el.reader_search_input.value.trim();
        if (!query || !this.pdf) return;

        this.el.search_results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Searching...</p>';

        const results = [];

        for (let i = 1; i <= this.totalPages; i++) {
            try {
                const page = await this.pdf.getPage(i);
                const textContent = await page.getTextContent();
                const text = textContent.items.map(item => item.str).join(' ');

                if (text.toLowerCase().includes(query.toLowerCase())) {
                    const idx = text.toLowerCase().indexOf(query.toLowerCase());
                    const start = Math.max(0, idx - 40);
                    const end = Math.min(text.length, idx + query.length + 40);
                    let snippet = text.substring(start, end);
                    if (start > 0) snippet = '...' + snippet;
                    if (end < text.length) snippet += '...';

                    results.push({ page: i, snippet });
                }
            } catch { /* skip */ }
        }

        this.el.search_results.innerHTML = '';

        if (results.length === 0) {
            this.el.search_results.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">No results found for "${query}"</p>`;
            return;
        }

        results.forEach(r => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.innerHTML = `
                <div>${r.snippet}</div>
                <div class="search-result-page">Page ${r.page}</div>
            `;
            div.addEventListener('click', () => {
                this.jumpToPage(r.page - 1);
                this.el.search_panel.classList.remove('open');
            });
            this.el.search_results.appendChild(div);
        });
    }

    async toggleBookmark() {
        const existing = this.bookmarks.find(
            bm => bm.bookId === this.currentBookId && bm.page === this.currentSpread
        );

        if (existing) {
            await this.db.deleteBookmark(existing.id);
            this.bookmarks = this.bookmarks.filter(b => b.id !== existing.id);
            this.toast('Bookmark removed');
        } else {
            const book = this.books.find(b => b.id === this.currentBookId);
            const bm = {
                id: 'bm_' + Date.now(),
                bookId: this.currentBookId,
                bookTitle: book?.title || 'Unknown',
                page: this.currentSpread,
                createdAt: Date.now()
            };
            await this.db.addBookmark(bm);
            this.bookmarks.push(bm);
            this.toast('Page bookmarked');
        }

        this.updateReaderUI();
    }

    togglePanel(panelId) {
        const panel = this.el[panelId];
        const isOpen = panel.classList.contains('open');
        this.closePanels();
        if (!isOpen) panel.classList.add('open');
    }

    closePanels() {
        document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
    }

    toggleFullscreen() {
        if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
            document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
            try {
                if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(e => {});
                else if (document.documentElement.webkitRequestFullscreen) document.documentElement.webkitRequestFullscreen();
            } catch(e) {}
            this.hideReaderHud();
            this.el.reader.style.cursor = 'none';
            this.toast('Immersive Mode');
        } else {
            try {
                if (document.exitFullscreen) document.exitFullscreen().catch(e => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } catch(e) {}
        }
    }

    toggleLockedImmersive() {
        this.isLockedImmersive = !this.isLockedImmersive;
        if (this.el.btn_qs_lock) {
            this.el.btn_qs_lock.classList.toggle('active', this.isLockedImmersive);
        }
        if (this.isLockedImmersive) {
            document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
            if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
                try {
                    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(e => {});
                    else if (document.documentElement.webkitRequestFullscreen) document.documentElement.webkitRequestFullscreen();
                } catch(e) {}
            }
            this.hideReaderHud();
            this.el.reader.style.cursor = 'none';
            if (this.el.btn_unlock_immersive) this.el.btn_unlock_immersive.classList.add('visible');
            this.toast('Locked Immersive Mode (Press L or tap floating unlock button)');
        } else {
            this.showReaderHud();
            if (this.el.btn_unlock_immersive) this.el.btn_unlock_immersive.classList.remove('visible');
            try {
                if (document.exitFullscreen) document.exitFullscreen().catch(e => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } catch(e) {}
            this.toast('UI Unlocked');
        }
    }

    showLoading(msg) {
        this.el.loading_text.textContent = msg;
        this.el.loading_bar_fill.style.width = '0%';
        this.el.loading_overlay.classList.add('show');
    }

    hideLoading() {
        this.el.loading_overlay.classList.remove('show');
    }

    toast(msg) {
        const container = this.el.toast_container;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = msg;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3200);
    }

    timeAgo(ts) {
        const diff = Date.now() - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 30) return `${days}d ago`;
        return new Date(ts).toLocaleDateString();
    }
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

const app = new BookShelfApp();