pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class ImmersiveBookReader {
    constructor() {
        this.pdf = null;
        this.pages = new Map();       // pageNum -> offscreen canvas
        this.totalPages = 0;
        this.currentSpread = 0;       // left page index (0-based)
        this.isFlipping = false;
        this.baseWidth = 0;
        this.baseHeight = 0;
        this.hudTimeout = null;
        this.wheelCooldown = false;
        this.fileName = '';

        this.cacheDom();
        this.bindEvents();
    }

    // ==================== DOM ====================
    cacheDom() {
        this.els = {
            uploadScreen: document.getElementById('upload-screen'),
            readerScreen: document.getElementById('reader-screen'),
            loading: document.getElementById('loading'),
            loadingMsg: document.getElementById('loading-msg'),
            fileInput: document.getElementById('pdf-input'),
            fileInfo: document.getElementById('file-info'),
            dropZone: document.getElementById('drop-zone'),
            book: document.getElementById('book'),
            bookWrapper: document.getElementById('book-wrapper'),
            leftPage: document.getElementById('left-page'),
            rightPage: document.getElementById('right-page'),
            leftContent: document.getElementById('left-content'),
            rightContent: document.getElementById('right-content'),
            leftNum: document.getElementById('left-num'),
            rightNum: document.getElementById('right-num'),
            leftEdges: document.getElementById('left-edges'),
            rightEdges: document.getElementById('right-edges'),
            flipContainer: document.getElementById('flip-container'),
            spine: document.getElementById('book-spine'),
            zoneLeft: document.getElementById('zone-left'),
            zoneRight: document.getElementById('zone-right'),
            hud: document.getElementById('hud'),
            hudPages: document.getElementById('hud-pages'),
            hudTitle: document.getElementById('hud-title'),
            btnBack: document.getElementById('btn-back'),
            btnFullscreen: document.getElementById('btn-fullscreen'),
            progressBar: document.getElementById('progress-bar'),
            progressFill: document.getElementById('progress-fill'),
            progressInput: document.getElementById('progress-input'),
        };
    }

    // ==================== EVENTS ====================
    bindEvents() {
        // File upload
        this.els.fileInput.addEventListener('change', e => {
            if (e.target.files[0]) this.openPDF(e.target.files[0]);
        });

        this.els.dropZone.addEventListener('click', () => this.els.fileInput.click());

        this.els.dropZone.addEventListener('dragover', e => {
            e.preventDefault();
            this.els.dropZone.classList.add('drag-over');
        });

        this.els.dropZone.addEventListener('dragleave', () => {
            this.els.dropZone.classList.remove('drag-over');
        });

        this.els.dropZone.addEventListener('drop', e => {
            e.preventDefault();
            this.els.dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file?.type === 'application/pdf') this.openPDF(file);
        });

        // Navigation
        this.els.zoneRight.addEventListener('click', () => this.nextSpread());
        this.els.zoneLeft.addEventListener('click', () => this.prevSpread());

        // Keyboard
        document.addEventListener('keydown', e => {
            if (this.els.readerScreen.classList.contains('hidden')) return;
            switch (e.key) {
                case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown':
                    e.preventDefault(); this.nextSpread(); break;
                case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
                    e.preventDefault(); this.prevSpread(); break;
                case 'Home':
                    e.preventDefault(); this.jumpToSpread(0); break;
                case 'End':
                    e.preventDefault(); this.jumpToSpread(this.totalPages - 1); break;
                case 'Escape':
                    e.preventDefault(); this.closeReader(); break;
                case 'f': case 'F':
                    e.preventDefault(); this.toggleFullscreen(); break;
            }
        });

        // Scroll / Wheel
        document.addEventListener('wheel', e => {
            if (this.els.readerScreen.classList.contains('hidden')) return;
            e.preventDefault();
            if (this.wheelCooldown) return;
            this.wheelCooldown = true;
            setTimeout(() => this.wheelCooldown = false, 500);

            if (e.deltaY > 0) this.nextSpread();
            else if (e.deltaY < 0) this.prevSpread();
        }, { passive: false });

        // Touch
        let touchStart = { x: 0, y: 0 };
        document.addEventListener('touchstart', e => {
            touchStart.x = e.changedTouches[0].screenX;
            touchStart.y = e.changedTouches[0].screenY;
        }, { passive: true });

        document.addEventListener('touchend', e => {
            if (this.els.readerScreen.classList.contains('hidden')) return;
            const dx = e.changedTouches[0].screenX - touchStart.x;
            const dy = e.changedTouches[0].screenY - touchStart.y;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) {
                if (dx < 0) this.nextSpread();
                else this.prevSpread();
            }
        }, { passive: true });

        // HUD
        let mouseTimer;
        document.addEventListener('mousemove', () => {
            if (this.els.readerScreen.classList.contains('hidden')) return;
            this.showHud();
            clearTimeout(mouseTimer);
            mouseTimer = setTimeout(() => this.hideHud(), 2500);
        });

        // Progress slider
        this.els.progressInput.addEventListener('input', e => {
            const val = parseInt(e.target.value);
            this.jumpToSpread(val);
        });

        // Buttons
        this.els.btnBack.addEventListener('click', () => this.closeReader());
        this.els.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());

        // Resize
        window.addEventListener('resize', () => {
            if (!this.els.readerScreen.classList.contains('hidden')) {
                this.layoutBook();
            }
        });
    }

    // ==================== PDF LOADING ====================
    async openPDF(file) {
        this.fileName = file.name.replace('.pdf', '');
        this.els.fileInfo.textContent = file.name;
        this.showLoading('Opening book...');

        try {
            const data = new Uint8Array(await file.arrayBuffer());
            this.pdf = await pdfjsLib.getDocument({ data }).promise;
            this.totalPages = this.pdf.numPages;

            // Get base dimensions
            const p1 = await this.pdf.getPage(1);
            const vp = p1.getViewport({ scale: 1 });
            this.baseWidth = vp.width;
            this.baseHeight = vp.height;

            // Pre-render
            this.pages.clear();
            for (let i = 1; i <= this.totalPages; i++) {
                this.els.loadingMsg.textContent = `Rendering page ${i} of ${this.totalPages}`;
                await this.renderPage(i);
            }

            // Setup
            this.currentSpread = 0;
            this.els.progressInput.max = Math.max(0, this.totalPages - 1);
            this.els.progressInput.value = 0;

            // Show reader
            this.els.uploadScreen.classList.add('hidden');
            this.els.readerScreen.classList.remove('hidden');
            this.hideLoading();

            this.els.hudTitle.textContent = this.fileName;
            this.els.bookWrapper.classList.add('intro');
            setTimeout(() => this.els.bookWrapper.classList.remove('intro'), 900);

            this.layoutBook();
            this.showHud();
            setTimeout(() => this.hideHud(), 3000);

        } catch (err) {
            console.error(err);
            this.hideLoading();
            alert('Could not open PDF. Please try another file.');
        }
    }

    async renderPage(num) {
        const page = await this.pdf.getPage(num);
        const scale = 2.5; // high res
        const vp = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;

        await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport: vp
        }).promise;

        this.pages.set(num, canvas);
    }

    // ==================== LAYOUT ====================
    layoutBook() {
        const vh = window.innerHeight;
        const vw = window.innerWidth;

        const ratio = this.baseWidth / this.baseHeight;

        // Book fills most of the screen
        let pageH = vh * 0.92;
        let pageW = pageH * ratio;

        // If two pages + spine + edges too wide, constrain
        const totalW = pageW * 2 + 12 + 28; // spine + edges
        if (totalW > vw * 0.96) {
            pageW = (vw * 0.96 - 12 - 28) / 2;
            pageH = pageW / ratio;
        }

        pageW = Math.floor(pageW);
        pageH = Math.floor(pageH);

        this.displayW = pageW;
        this.displayH = pageH;

        // Apply sizes
        this.els.leftPage.style.width = pageW + 'px';
        this.els.leftPage.style.height = pageH + 'px';
        this.els.rightPage.style.width = pageW + 'px';
        this.els.rightPage.style.height = pageH + 'px';
        this.els.spine.style.height = pageH + 'px';
        this.els.leftEdges.style.height = (pageH - 8) + 'px';
        this.els.rightEdges.style.height = (pageH - 8) + 'px';

        this.drawSpread();
    }

    // ==================== DRAWING ====================
    drawSpread() {
        const leftNum = this.currentSpread + 1;
        const rightNum = this.currentSpread + 2;

        this.drawPageInto(this.els.leftContent, leftNum);
        this.drawPageInto(this.els.rightContent, rightNum);

        // Page numbers
        this.els.leftNum.textContent = leftNum <= this.totalPages ? leftNum : '';
        this.els.rightNum.textContent = rightNum <= this.totalPages ? rightNum : '';

        // Empty page styling
        this.els.leftPage.classList.toggle('empty-page', leftNum > this.totalPages);
        this.els.rightPage.classList.toggle('empty-page', rightNum > this.totalPages);

        // Page edges thickness based on position
        const progressLeft = this.currentSpread / this.totalPages;
        const leftThickness = Math.max(3, Math.floor(14 * progressLeft));
        const rightThickness = Math.max(3, 14 - leftThickness);
        this.els.leftEdges.style.width = leftThickness + 'px';
        this.els.rightEdges.style.width = rightThickness + 'px';

        // Hide left edges on first spread
        this.els.leftEdges.style.display = this.currentSpread === 0 ? 'none' : 'block';
        this.els.rightEdges.style.display =
            this.currentSpread + 2 >= this.totalPages ? 'none' : 'block';

        this.updateUI();
    }

    drawPageInto(container, pageNum) {
        container.innerHTML = '';

        if (pageNum < 1 || pageNum > this.totalPages) return;

        const src = this.pages.get(pageNum);
        if (!src) return;

        const canvas = document.createElement('canvas');
        canvas.width = this.displayW * 2; // retina
        canvas.height = this.displayH * 2;
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        const ctx = canvas.getContext('2d');
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

        container.appendChild(canvas);
    }

    makeFlipCanvas(pageNum) {
        const w = this.displayW;
        const h = this.displayH;

        const canvas = document.createElement('canvas');
        canvas.width = w * 2;
        canvas.height = h * 2;
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        if (pageNum >= 1 && pageNum <= this.totalPages) {
            const src = this.pages.get(pageNum);
            if (src) {
                canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
            }
        }

        return canvas;
    }

    // ==================== FLIPPING ====================
    async nextSpread() {
        if (this.isFlipping) return;
        if (this.currentSpread + 2 >= this.totalPages) return;

        this.isFlipping = true;
        const next = this.currentSpread + 2;

        await this.animateFlip('forward', next);

        this.currentSpread = next;
        this.els.flipContainer.innerHTML = '';
        this.drawSpread();
        this.isFlipping = false;
    }

    async prevSpread() {
        if (this.isFlipping) return;
        if (this.currentSpread <= 0) return;

        this.isFlipping = true;
        const prev = this.currentSpread - 2;

        await this.animateFlip('backward', prev);

        this.currentSpread = prev;
        this.els.flipContainer.innerHTML = '';
        this.drawSpread();
        this.isFlipping = false;
    }

    animateFlip(direction, targetSpread) {
        return new Promise(resolve => {
            const container = this.els.flipContainer;
            container.innerHTML = '';

            if (direction === 'forward') {
                // The right page lifts and flips to the left
                // Front of leaf: current right page (currentSpread + 2)
                // Back of leaf:  next left page (targetSpread + 1)

                const leaf = document.createElement('div');
                leaf.className = 'flip-leaf from-right';
                leaf.style.width = this.displayW + 'px';
                leaf.style.height = this.displayH + 'px';

                // Front face
                const front = document.createElement('div');
                front.className = 'flip-face flip-face-front';
                front.appendChild(this.makeFlipCanvas(this.currentSpread + 2));
                leaf.appendChild(front);

                // Back face
                const back = document.createElement('div');
                back.className = 'flip-face flip-face-back';
                back.appendChild(this.makeFlipCanvas(targetSpread + 1));
                leaf.appendChild(back);

                container.appendChild(leaf);

                // Shadow overlay on left page during flip
                const shadow = document.createElement('div');
                shadow.className = 'flip-shadow-overlay on-left';
                container.appendChild(shadow);

                // Update the right page underneath to show the next right page
                this.drawPageInto(this.els.rightContent, targetSpread + 2);
                this.els.rightNum.textContent =
                    targetSpread + 2 <= this.totalPages ? targetSpread + 2 : '';

                // Trigger flip
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        leaf.style.transform = 'rotateY(-180deg)';
                        shadow.classList.add('active');

                        setTimeout(() => {
                            shadow.classList.remove('active');
                            resolve();
                        }, 750);
                    });
                });

            } else {
                // The left page lifts from the left and flips to the right
                // Front: current left page (currentSpread + 1)
                // Back: previous right page (targetSpread + 2)

                const leaf = document.createElement('div');
                leaf.className = 'flip-leaf from-left';
                leaf.style.width = this.displayW + 'px';
                leaf.style.height = this.displayH + 'px';

                // Front
                const front = document.createElement('div');
                front.className = 'flip-face flip-face-front';
                front.appendChild(this.makeFlipCanvas(this.currentSpread + 1));
                leaf.appendChild(front);

                // Back
                const back = document.createElement('div');
                back.className = 'flip-face flip-face-back';
                back.appendChild(this.makeFlipCanvas(targetSpread + 2));
                leaf.appendChild(back);

                container.appendChild(leaf);

                // Shadow on right page
                const shadow = document.createElement('div');
                shadow.className = 'flip-shadow-overlay on-right';
                container.appendChild(shadow);

                // Update left page underneath
                this.drawPageInto(this.els.leftContent, targetSpread + 1);
                this.els.leftNum.textContent =
                    targetSpread + 1 >= 1 ? targetSpread + 1 : '';

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        leaf.style.transform = 'rotateY(180deg)';
                        shadow.classList.add('active');

                        setTimeout(() => {
                            shadow.classList.remove('active');
                            resolve();
                        }, 750);
                    });
                });
            }
        });
    }

    jumpToSpread(pageIndex) {
        if (this.isFlipping) return;
        const spread = Math.floor(pageIndex / 2) * 2;
        const clamped = Math.max(0, Math.min(spread, this.totalPages - 1));
        if (clamped === this.currentSpread) return;
        this.currentSpread = clamped;
        this.drawSpread();
    }

    // ==================== UI ====================
    updateUI() {
        const left = this.currentSpread + 1;
        const right = Math.min(this.currentSpread + 2, this.totalPages);

        this.els.hudPages.textContent =
            left === right
                ? `${left}  /  ${this.totalPages}`
                : `${left} – ${right}  /  ${this.totalPages}`;

        this.els.progressInput.value = this.currentSpread;

        const pct = ((this.currentSpread + 2) / this.totalPages) * 100;
        this.els.progressFill.style.width = Math.min(100, pct) + '%';
    }

    showHud() {
        this.els.hud.classList.add('visible');
        this.els.progressBar.style.opacity = '1';
    }

    hideHud() {
        this.els.hud.classList.remove('visible');
        this.els.progressBar.style.opacity = '';
    }

    closeReader() {
        if (document.fullscreenElement) document.exitFullscreen();
        this.els.readerScreen.classList.add('hidden');
        this.els.uploadScreen.classList.remove('hidden');
        this.pdf = null;
        this.pages.clear();
        this.els.fileInput.value = '';
        this.els.fileInfo.textContent = '';
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }

    showLoading(msg) {
        this.els.loadingMsg.textContent = msg;
        this.els.loading.classList.remove('hidden');
    }

    hideLoading() {
        this.els.loading.classList.add('hidden');
    }
}

// Boot
const reader = new ImmersiveBookReader();