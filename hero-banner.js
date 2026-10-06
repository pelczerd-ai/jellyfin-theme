/**
 * Jellyfin Netflix-stílusú Hero Banner & Automata Trailer Modul
 * Tiszta mozis élmény: automatikus trailer induláskor feliratok elhalványulnak (fade-out)
 * TV távirányító (Spatial Navigation) és desktop támogatás
 */

(function () {
    'use strict';

    const SLIDE_DURATION = 10000; // 10 mp diánként, ha nem indul trailer
    const TRAILER_DELAY = 3500;   // 3.5 mp után indul a trailer
    let heroItems = [];
    let currentIndex = 0;
    let slideTimer = null;
    let trailerTimer = null;
    let currentVideoEl = null;
    let currentYtIframe = null;
    let bannerEl = null;
    let userActivityTimeout = null;

    function getApiClient() {
        return window.ApiClient || (window.connectionManager && window.connectionManager.currentApiClient());
    }

    function isHomePage() {
        const hash = window.location.hash || '';
        return hash === '' || hash === '#/' || hash.startsWith('#/home') || hash.startsWith('#!/home');
    }

    function setElementFocus(el, options) {
        if (!el) return false;
        const preventScroll = !options || options.preventScroll !== false;

        // TV spatial nav gyakran tabindex-et vár nem-natív elemeken
        if (!el.matches('button, a, select, input, textarea, [tabindex]') && el.tabIndex < 0) {
            el.tabIndex = 0;
        }

        try {
            if (window.focusManager && typeof window.focusManager.focus === 'function') {
                window.focusManager.focus(el);
            }
        } catch {}

        if (document.activeElement !== el && !(el.contains && el.contains(document.activeElement))) {
            try {
                el.focus({ preventScroll: preventScroll });
            } catch {
                try { el.focus(); } catch {}
            }
        }

        return document.activeElement === el || !!(el.contains && el.contains(document.activeElement));
    }

    async function fetchRandomItems() {
        const client = getApiClient();
        if (!client) return [];

        const userId = client.getCurrentUserId ? client.getCurrentUserId() : null;
        if (!userId) return [];

        try {
            const url = client.getUrl('/Users/' + userId + '/Items', {
                SortBy: 'Random',
                Limit: 12,
                Recursive: true,
                IncludeItemTypes: 'Movie,Series',
                Fields: 'Overview,Genres,CommunityRating,PremiereDate,RemoteTrailers',
                ImageTypes: 'Backdrop,Logo',
                EnableImageTypes: 'Backdrop,Logo'
            });

            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': client.accessToken ? 'MediaBrowser Token="' + client.accessToken() + '"' : ''
                }
            });

            if (!res.ok) return [];
            const data = await res.json();
            const items = (data.Items || []).filter(item => item.BackdropImageTags && item.BackdropImageTags.length > 0);
            return items.slice(0, 5);
        } catch (err) {
            console.warn('[HeroBanner] API hiba:', err);
            return [];
        }
    }

    async function getLocalTrailer(itemId) {
        const client = getApiClient();
        if (!client) return null;

        try {
            const url = client.getUrl('/Items/' + itemId + '/LocalTrailers');
            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': client.accessToken ? 'MediaBrowser Token="' + client.accessToken() + '"' : ''
                }
            });
            if (!res.ok) return null;
            const trailers = await res.json();
            return (trailers && trailers.length > 0) ? trailers[0] : null;
        } catch {
            return null;
        }
    }

    const preloadedImageCache = new Map();
    let activeBackdropLayer = 1;

    function preloadHeroImages(items) {
        const client = getApiClient();
        if (!client || !items) return;

        items.forEach(item => {
            // Háttérkép előtöltése
            const backdropUrl = client.getUrl('/Items/' + item.Id + '/Images/Backdrop/0', {
                maxWidth: 1920,
                quality: 85
            });
            if (!preloadedImageCache.has(backdropUrl)) {
                const img = new Image();
                img.src = backdropUrl;
                preloadedImageCache.set(backdropUrl, img);
            }

            // Logó előtöltése
            if (item.ImageTags && item.ImageTags.Logo) {
                const logoUrl = client.getUrl('/Items/' + item.Id + '/Images/Logo', {
                    maxWidth: 500,
                    quality: 90
                });
                if (!preloadedImageCache.has(logoUrl)) {
                    const lImg = new Image();
                    lImg.src = logoUrl;
                    preloadedImageCache.set(logoUrl, lImg);
                }
            }
        });
    }

    function setBackdropWithCrossfade(url) {
        if (!bannerEl) return;
        const layer1 = bannerEl.querySelector('.hero-backdrop-1');
        const layer2 = bannerEl.querySelector('.hero-backdrop-2');
        if (!layer1 || !layer2) return;

        const nextLayer = activeBackdropLayer === 1 ? layer2 : layer1;
        const currentLayer = activeBackdropLayer === 1 ? layer1 : layer2;

        nextLayer.style.backgroundImage = `url("${url}")`;
        nextLayer.classList.add('active');
        currentLayer.classList.remove('active');
        activeBackdropLayer = activeBackdropLayer === 1 ? 2 : 1;
    }

    function extractYouTubeId(url) {
        if (!url) return null;
        const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
        return m ? m[1] : null;
    }

    function createBannerDOM() {
        const banner = document.createElement('div');
        banner.className = 'hero-banner focuscontainer-x';
        banner.innerHTML = `
            <div class="hero-media-container">
                <div class="hero-backdrop hero-backdrop-1 active"></div>
                <div class="hero-backdrop hero-backdrop-2"></div>
                <div class="hero-video-wrapper"></div>
                <div class="hero-gradient-overlay"></div>
            </div>
            <div class="hero-info-container">
                <div class="hero-logo-container"></div>
                <div class="hero-meta">
                    <span class="hero-rating"></span>
                    <span class="hero-year"></span>
                    <span class="hero-genres"></span>
                </div>
                <div class="hero-overview"></div>
                <div class="hero-actions focuscontainer-x">
                    <button class="emby-button hero-btn hero-btn-play focusable" type="button" tabindex="0">
                        <span class="material-icons">play_arrow</span>
                        <span class="hero-btn-text">Lejátszás</span>
                    </button>
                    <button class="emby-button hero-btn hero-btn-details focusable" type="button" tabindex="0">
                        <span class="material-icons">info_outline</span>
                        <span class="hero-btn-text">Részletek</span>
                    </button>
                </div>
            </div>
            <div class="hero-controls-bar">
                <div class="hero-indicators"></div>
                <div class="hero-nav-arrows">
                    <button class="emby-button hero-nav-btn hero-nav-prev focusable" type="button" tabindex="0" title="Előző dia">
                        <span class="material-icons">chevron_left</span>
                    </button>
                    <button class="emby-button hero-nav-btn hero-nav-next focusable" type="button" tabindex="0" title="Következő dia">
                        <span class="material-icons">chevron_right</span>
                    </button>
                </div>
            </div>
        `;

        // Eseménykezelők a gombokhoz
        const playBtn = banner.querySelector('.hero-btn-play');
        const detailsBtn = banner.querySelector('.hero-btn-details');
        const prevBtn = banner.querySelector('.hero-nav-prev');
        const nextBtn = banner.querySelector('.hero-nav-next');

        playBtn.addEventListener('click', () => {
            const item = heroItems[currentIndex];
            if (item) navigateToDetails(item.Id);
        });

        detailsBtn.addEventListener('click', () => {
            const item = heroItems[currentIndex];
            if (item) navigateToDetails(item.Id);
        });

        prevBtn.addEventListener('click', () => {
            prevSlide();
        });

        nextBtn.addEventListener('click', () => {
            nextSlide();
        });

        function focusNextBelowBanner() {
            stopTrailer();
            let target = null;
            if (banner.parentElement) {
                const siblings = Array.from(banner.parentElement.children);
                const bannerIndex = siblings.indexOf(banner);
                for (let i = bannerIndex + 1; i < siblings.length; i++) {
                    const sib = siblings[i];
                    const card = sib.querySelector('.card, .cardBox, .cardContent-button, .visualCardBox, [data-action]');
                    if (card && card.offsetParent !== null) {
                        target = card;
                        break;
                    }
                }
            }

            if (!target) {
                const allCards = Array.from(document.querySelectorAll('.card, .cardContent-button, .cardBox, .visualCardBox'));
                const bannerBottom = banner.getBoundingClientRect().bottom;
                for (const c of allCards) {
                    if (banner.contains(c) || c.offsetParent === null) continue;
                    const r = c.getBoundingClientRect();
                    if (r.top >= bannerBottom - 40) {
                        target = c;
                        break;
                    }
                }
            }

            if (target) {
                const el = target.matches('button, a, [tabindex="0"]') ? target : (target.querySelector('button, a, [tabindex="0"]') || target);
                setElementFocus(el);
            }
        }

        function focusHeaderFromBanner() {
            stopTrailer();
            const tabs = Array.from(document.querySelectorAll('.emby-tab-button, .headerTabs button, .sectionTabs button, .headerTop button, .skinHeader button'));
            // 1. Látható aktív fül (pl. TV fejléc fül)
            let target = tabs.find(t => t.classList.contains('emby-tab-button-active') && t.offsetParent !== null);

            // 2. Bármilyen látható fül
            if (!target) {
                target = tabs.find(t => t.classList.contains('emby-tab-button') && t.offsetParent !== null);
            }

            // 3. Bármilyen egyéb látható fejléc gomb (pl. menü, kereső, profil)
            if (!target) {
                target = tabs.find(t => t.offsetParent !== null);
            }

            if (target) {
                setElementFocus(target);
            }
        }

        // Távirányító nyílgombos navigáció (Spatial Navigation)
        banner.addEventListener('keydown', (e) => {
            resetUserActivity();
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                focusNextBelowBanner();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                focusHeaderFromBanner();
            } else if (e.key === 'ArrowLeft') {
                if (e.target === detailsBtn) {
                    e.preventDefault();
                    setElementFocus(playBtn);
                } else if (e.target === prevBtn) {
                    e.preventDefault();
                    setElementFocus(detailsBtn);
                } else if (e.target === nextBtn) {
                    e.preventDefault();
                    setElementFocus(prevBtn);
                }
            } else if (e.key === 'ArrowRight') {
                if (e.target === playBtn) {
                    e.preventDefault();
                    setElementFocus(detailsBtn);
                } else if (e.target === detailsBtn) {
                    e.preventDefault();
                    setElementFocus(prevBtn);
                } else if (e.target === prevBtn) {
                    e.preventDefault();
                    setElementFocus(nextBtn);
                }
            }
        });

        // Mozgás érzékelés: ha mozog az egér vagy fókusz változik, jöjjenek vissza a vezérlők
        banner.addEventListener('mousemove', resetUserActivity, { passive: true });
        banner.addEventListener('focusin', resetUserActivity);

        return banner;
    }

    function resetUserActivity() {
        if (!bannerEl) return;
        bannerEl.classList.remove('media-hidden');

        clearTimeout(userActivityTimeout);
        // Ha van éppen futó videó, 4 másodperc inaktivitás után újra elhalványul a felirat
        if (bannerEl.classList.contains('is-playing')) {
            userActivityTimeout = setTimeout(() => {
                if (bannerEl && bannerEl.classList.contains('is-playing')) {
                    bannerEl.classList.add('media-hidden');
                }
            }, 4000);
        }
    }

    function navigateToDetails(itemId) {
        stopTrailer();
        if (window.appRouter && window.appRouter.showItem) {
            window.appRouter.showItem(itemId);
        } else {
            window.location.hash = '#/details?id=' + itemId;
        }
    }

    function stopTrailer() {
        clearTimeout(trailerTimer);
        clearTimeout(userActivityTimeout);

        if (currentVideoEl) {
            currentVideoEl.pause();
            currentVideoEl.removeAttribute('src');
            currentVideoEl.load();
            currentVideoEl.remove();
            currentVideoEl = null;
        }

        if (currentYtIframe) {
            currentYtIframe.remove();
            currentYtIframe = null;
        }

        if (bannerEl) {
            bannerEl.classList.remove('is-playing');
            bannerEl.classList.remove('media-hidden');
            const videoWrapper = bannerEl.querySelector('.hero-video-wrapper');
            if (videoWrapper) videoWrapper.innerHTML = '';
        }
    }

    async function renderSlide(index) {
        if (!heroItems || heroItems.length === 0) return;
        currentIndex = (index + heroItems.length) % heroItems.length;
        const item = heroItems[currentIndex];
        const client = getApiClient();
        if (!item || !client || !bannerEl) return;

        stopTrailer();

        // 1. Háttérkép (azonnali cross-fade a preloaded gyorsítótárból)
        const backdropUrl = client.getUrl('/Items/' + item.Id + '/Images/Backdrop/0', {
            maxWidth: 1920,
            quality: 85
        });
        setBackdropWithCrossfade(backdropUrl);

        // 2. Logó vagy Cím szöveg
        const logoContainer = bannerEl.querySelector('.hero-logo-container');
        logoContainer.innerHTML = '';
        if (item.ImageTags && item.ImageTags.Logo) {
            const logoUrl = client.getUrl('/Items/' + item.Id + '/Images/Logo', {
                maxWidth: 500,
                quality: 90
            });
            const img = document.createElement('img');
            img.src = logoUrl;
            img.className = 'hero-logo';
            img.alt = item.Name;
            logoContainer.appendChild(img);
        } else {
            const title = document.createElement('h1');
            title.className = 'hero-title';
            title.textContent = item.Name;
            logoContainer.appendChild(title);
        }

        // 3. Meta adatok
        const ratingEl = bannerEl.querySelector('.hero-rating');
        ratingEl.textContent = item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : '';
        ratingEl.style.display = item.CommunityRating ? 'inline-block' : 'none';

        const yearEl = bannerEl.querySelector('.hero-year');
        const year = item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : '';
        yearEl.textContent = year;

        const genresEl = bannerEl.querySelector('.hero-genres');
        genresEl.textContent = (item.Genres && item.Genres.length > 0) ? item.Genres.slice(0, 3).join(' • ') : '';

        // 4. Rövid leírás (Overview)
        const overviewEl = bannerEl.querySelector('.hero-overview');
        overviewEl.textContent = item.Overview || '';

        // 5. Indikátorok frissítése
        const indicators = bannerEl.querySelectorAll('.hero-indicator');
        indicators.forEach((ind, i) => {
            ind.classList.toggle('active', i === currentIndex);
        });

        // 6. Automata trailer időzítő (3.5 másodperc múlva)
        trailerTimer = setTimeout(async () => {
            await startTrailer(item);
        }, TRAILER_DELAY);

        // 7. Diánkénti léptetés időzítő (ha nincs trailer)
        clearTimeout(slideTimer);
        slideTimer = setTimeout(() => {
            if (!bannerEl.classList.contains('is-playing')) {
                nextSlide();
            }
        }, SLIDE_DURATION);
    }

    async function startTrailer(item) {
        const client = getApiClient();
        if (!client || !bannerEl) return;
        const videoWrapper = bannerEl.querySelector('.hero-video-wrapper');
        if (!videoWrapper) return;

        // 1. Megpróbáljuk a helyi trailer fájlt
        const localTrailer = await getLocalTrailer(item.Id);
        if (localTrailer) {
            const streamUrl = client.getUrl('/Videos/' + localTrailer.Id + '/stream', {
                static: true
            });

            const video = document.createElement('video');
            video.className = 'hero-video';
            video.src = streamUrl;
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.loop = true;

            video.onplaying = () => {
                onTrailerStarted();
            };

            videoWrapper.innerHTML = '';
            videoWrapper.appendChild(video);
            currentVideoEl = video;
            return;
        }

        // 2. Másodlagos: YouTube előzetes
        if (item.RemoteTrailers && item.RemoteTrailers.length > 0) {
            for (const rt of item.RemoteTrailers) {
                const ytId = extractYouTubeId(rt.Url);
                if (ytId) {
                    const iframe = document.createElement('iframe');
                    iframe.className = 'hero-video hero-youtube-iframe';
                    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
                    const origin = encodeURIComponent(window.location.origin);
                    iframe.src = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${ytId}&playsinline=1&rel=0&enablejsapi=1&origin=${origin}`;
                    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
                    iframe.frameBorder = '0';

                    videoWrapper.innerHTML = '';
                    videoWrapper.appendChild(iframe);
                    currentYtIframe = iframe;

                    // YouTube esetén 1 mp múlva jelezzük az indulást
                    setTimeout(onTrailerStarted, 1000);
                    return;
                }
            }
        }
    }

    function onTrailerStarted() {
        if (!bannerEl) return;
        bannerEl.classList.add('is-playing');

        // Tiszta mozis mód: 1.5 mp múlva elhalványulnak a feliratok
        clearTimeout(userActivityTimeout);
        userActivityTimeout = setTimeout(() => {
            if (bannerEl && bannerEl.classList.contains('is-playing')) {
                bannerEl.classList.add('media-hidden');
            }
        }, 1500);
    }

    function nextSlide() {
        renderSlide(currentIndex + 1);
    }

    function prevSlide() {
        renderSlide(currentIndex - 1);
    }

    let isInitializing = false;
    let retryCount = 0;

    async function initHeroBanner() {
        if (!isHomePage()) {
            stopTrailer();
            if (bannerEl) {
                bannerEl.remove();
                bannerEl = null;
            }
            return;
        }

        // Megkeressük a kezdőlap konténerét
        const container = document.querySelector('.homeSectionsContainer') || 
                          document.querySelector('#homeTab .sections') ||
                          document.querySelector('#homeTab') ||
                          document.querySelector('.page:not(.hide) .sections') ||
                          document.querySelector('#indexPage .sections') ||
                          document.querySelector('.page.is-active .sections');

        if (!container) {
            if (retryCount < 20) {
                retryCount++;
                setTimeout(initHeroBanner, 500);
            }
            return;
        }

        // Ha már létezik a banner a DOM-ban, nem szúrjuk be újra
        if (container.querySelector('.hero-banner')) return;

        if (isInitializing) return;
        isInitializing = true;

        try {
            if (heroItems.length === 0) {
                heroItems = await fetchRandomItems();
                if (heroItems.length === 0) {
                    if (retryCount < 20) {
                        retryCount++;
                        setTimeout(initHeroBanner, 1000);
                    }
                    return;
                }
                // Az összes dia képeit és logóit azonnal előretöltjük a memóriába
                preloadHeroImages(heroItems);
            }

            // Ha időközben már beszúródott volna
            if (container.querySelector('.hero-banner')) return;

            bannerEl = createBannerDOM();
            container.insertBefore(bannerEl, container.firstChild);

            // Indikátorok felépítése
            const indContainer = bannerEl.querySelector('.hero-indicators');
            indContainer.innerHTML = '';
            heroItems.forEach((_, idx) => {
                const dot = document.createElement('div');
                dot.className = 'hero-indicator' + (idx === 0 ? ' active' : '');
                dot.addEventListener('click', () => renderSlide(idx));
                indContainer.appendChild(dot);
            });

            renderSlide(0);
        } finally {
            isInitializing = false;
        }
    }

    // Globális aktivitás figyelés: egér és billentyűzet/távirányító
    window.addEventListener('mousemove', resetUserActivity, { passive: true });
    window.addEventListener('keydown', resetUserActivity, { passive: true });

    // YouTube lejátszási hibák csendes kezelése (ha pl. jogvédett/letiltott beágyazású a videó)
    window.addEventListener('message', (event) => {
        if (!event.origin || !event.origin.includes('youtube.com')) return;
        try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            if (data && (data.event === 'onError' || (data.info && data.info.playerState === -1 && data.info.errorCode))) {
                stopTrailer();
            }
        } catch {}
    });

    // ==========================================================================
    // TARTALOM RÉSZLETEK OLDAL (.itemDetailPage) MODUL — LOGÓ, TRAILER & NAVIGÁCIÓ
    // ==========================================================================

    let lastHandledDetailItemId = null;
    let detailFocusTimeout = null;
    let currentDetailVideo = null;
    const itemDetailsCache = new Map();

    function getItemIdFromUrl() {
        const hash = window.location.hash || '';
        const match = hash.match(/[?&]id=([^&]+)/);
        return match ? match[1] : null;
    }

    function isItemDetailPage() {
        const hash = window.location.hash || '';
        return hash.includes('details') || hash.includes('item?') || !!document.querySelector('.itemDetailPage');
    }

    function resetScrollToTop(detailPage) {
        const doScroll = () => {
            window.scrollTo(0, 0);
            if (document.documentElement) document.documentElement.scrollTop = 0;
            if (document.body) document.body.scrollTop = 0;
            if (detailPage) detailPage.scrollTop = 0;
            const scrollers = document.querySelectorAll('.pageContainer, .mainAnimatedPages, .mainAnimatedPage, .itemDetailPage');
            scrollers.forEach(s => { s.scrollTop = 0; });
        };
        doScroll();
        requestAnimationFrame(doScroll);
        setTimeout(doScroll, 120);
        setTimeout(doScroll, 350);
    }

    function enforceLeftAlignment(detailPage) {
        if (!detailPage) return;
        const ribbon = detailPage.querySelector('.detailRibbon');
        if (ribbon) {
            ribbon.style.setProperty('align-items', 'flex-start', 'important');
            ribbon.style.setProperty('padding-left', '4.2rem', 'important');
        }
        const infoWrapper = detailPage.querySelector('.infoWrapper');
        if (infoWrapper) {
            infoWrapper.style.setProperty('align-items', 'flex-start', 'important');
            infoWrapper.style.setProperty('align-self', 'flex-start', 'important');
            infoWrapper.style.setProperty('justify-content', 'flex-start', 'important');
            infoWrapper.style.setProperty('text-align', 'left', 'important');
            infoWrapper.style.setProperty('margin-left', '0px', 'important');
            infoWrapper.style.setProperty('margin-right', 'auto', 'important');
            infoWrapper.style.setProperty('padding-left', '0px', 'important');
            infoWrapper.style.setProperty('padding-right', '0px', 'important');
            infoWrapper.style.setProperty('width', '100%', 'important');
            infoWrapper.style.setProperty('flex', '0 0 auto', 'important');
            infoWrapper.style.setProperty('flex-grow', '0', 'important');
            infoWrapper.style.setProperty('margin-top', 'auto', 'important');
        }
        const miscInfo = detailPage.querySelector('.itemMiscInfo');
        if (miscInfo) {
            miscInfo.style.setProperty('justify-content', 'flex-start', 'important');
            miscInfo.style.setProperty('align-items', 'flex-start', 'important');
            miscInfo.style.setProperty('align-self', 'flex-start', 'important');
            miscInfo.style.setProperty('text-align', 'left', 'important');
            miscInfo.style.setProperty('margin-left', '0px', 'important');
            miscInfo.style.setProperty('margin-right', 'auto', 'important');
            miscInfo.style.setProperty('padding-left', '0px', 'important');
            miscInfo.style.setProperty('padding-right', '0px', 'important');
        }
        const nameCont = detailPage.querySelector('.nameContainer');
        if (nameCont) {
            nameCont.style.setProperty('align-items', 'flex-start', 'important');
            nameCont.style.setProperty('align-self', 'flex-start', 'important');
            nameCont.style.setProperty('text-align', 'left', 'important');
            nameCont.style.setProperty('margin-left', '0px', 'important');
            nameCont.style.setProperty('margin-right', 'auto', 'important');
            nameCont.style.setProperty('padding-left', '0px', 'important');
        }
        const logo = detailPage.querySelector('.custom-detail-logo');
        if (logo) {
            logo.style.setProperty('align-self', 'flex-start', 'important');
            logo.style.setProperty('margin-left', '0px', 'important');
            logo.style.setProperty('margin-right', 'auto', 'important');
            logo.style.setProperty('padding-left', '0px', 'important');
            logo.style.setProperty('background-position', 'left center', 'important');
        }
        const buttons = detailPage.querySelector('.mainDetailButtons');
        if (buttons) {
            buttons.style.setProperty('align-self', 'flex-start', 'important');
            buttons.style.setProperty('justify-content', 'flex-start', 'important');
            buttons.style.setProperty('margin-left', '0px', 'important');
            buttons.style.setProperty('padding-left', '0px', 'important');
        }
    }

    async function enhanceItemDetailPage() {
        const detailPage = document.querySelector('.itemDetailPage:not(.hide)') || document.querySelector('.itemDetailPage');
        if (!detailPage) {
            if (isItemDetailPage()) {
                setTimeout(enhanceItemDetailPage, 60);
            }
            return;
        }

        const itemId = getItemIdFromUrl() || detailPage.getAttribute('data-id');
        if (!itemId) {
            if (isItemDetailPage()) {
                setTimeout(enhanceItemDetailPage, 60);
            }
            return;
        }

        const detailRibbon = detailPage.querySelector('.detailRibbon');
        const nameContainer = detailPage.querySelector('.nameContainer') || detailPage.querySelector('.itemName');
        if (!detailRibbon || !nameContainer) {
            setTimeout(enhanceItemDetailPage, 60);
            return;
        }

        const isNewItem = (lastHandledDetailItemId !== itemId);
        if (isNewItem) {
            lastHandledDetailItemId = itemId;
            stopDetailTrailer();
        }

        // 1. Dedikált mozis hero háttérkép (Backdrop) és előzetes kezelése
        setupDetailBackdrop(detailPage, itemId);

        // 2. Hivatalos logó kezelése (ClearLogo)
        setupDetailLogo(detailPage, itemId);

        // 3. Balra zárt elrendezés megerősítése
        enforceLeftAlignment(detailPage);

        // 4. Automatikus fókusz a Lejátszás gombra
        if (isNewItem) {
            triggerDetailInitialFocus(detailPage);
        }
        bindDetailNavKeys(detailPage);
    }

    function stopDetailTrailer() {
        if (currentDetailVideo) {
            try {
                currentDetailVideo.pause();
                currentDetailVideo.src = '';
                currentDetailVideo.load();
            } catch {}
            currentDetailVideo = null;
        }
        const wrappers = document.querySelectorAll('.detail-video-wrapper');
        wrappers.forEach(w => {
            w.innerHTML = '';
        });
        const detailPage = document.querySelector('.itemDetailPage');
        if (detailPage) {
            delete detailPage.dataset.trailerItemId;
        }
    }

    async function getItemDetails(itemId) {
        if (itemDetailsCache.has(itemId)) {
            return itemDetailsCache.get(itemId);
        }

        const client = getApiClient();
        if (!client) return null;
        const userId = client.getCurrentUserId ? client.getCurrentUserId() : null;
        const fields = 'RemoteTrailers,ImageTags,BackdropImageTags,PrimaryImageAspectRatio,SeriesId,SeasonId,ParentId,ParentBackdropItemId,ParentBackdropImageTags,SeriesPrimaryImageTag,ParentThumbItemId,ParentThumbImageTag';

        try {
            if (client.getItem && userId) {
                const item = await client.getItem(userId, itemId);
                if (item) {
                    itemDetailsCache.set(itemId, item);
                    return item;
                }
            }
        } catch {}

        const endpoints = [];
        if (userId) {
            endpoints.push(client.getUrl('/Users/' + userId + '/Items/' + itemId, { Fields: fields }));
        }
        endpoints.push(client.getUrl('/Items/' + itemId, { Fields: fields }));

        for (const url of endpoints) {
            try {
                const res = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': client.accessToken ? 'MediaBrowser Token="' + client.accessToken() + '"' : ''
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data) {
                        itemDetailsCache.set(itemId, data);
                        return data;
                    }
                }
            } catch {}
        }
        return null;
    }

    function buildItemImageUrl(client, itemId, imageType, options) {
        const params = Object.assign({ maxWidth: 1920, quality: 90 }, options || {});
        return client.getUrl('/Items/' + itemId + '/Images/' + imageType + (params.index != null ? '/' + params.index : ''), {
            maxWidth: params.maxWidth,
            quality: params.quality,
            tag: params.tag || undefined
        });
    }

    function imageUrlExists(url) {
        return new Promise((resolve) => {
            if (!url) {
                resolve(false);
                return;
            }
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = url;
        });
    }

    /**
     * Epizód: saját Backdrop → Parent Backdrop → saját Primary → sorozat Backdrop → sorozat Primary
     * Film/sorozat: Backdrop → Primary
     * Epizódnál nincs trailer — csak kép.
     */
    async function resolveDetailHeroImageUrl(itemId) {
        const client = getApiClient();
        if (!client) return null;

        const item = await getItemDetails(itemId);
        const candidates = [];

        const push = (id, type, opts) => {
            if (!id || !type) return;
            candidates.push(buildItemImageUrl(client, id, type, opts));
        };

        if (item) {
            if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                push(item.Id, 'Backdrop', { index: 0, tag: item.BackdropImageTags[0] });
            }

            if (item.Type === 'Episode') {
                if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0) {
                    push(item.ParentBackdropItemId, 'Backdrop', { index: 0, tag: item.ParentBackdropImageTags[0] });
                }
                if (item.ImageTags && item.ImageTags.Primary) {
                    push(item.Id, 'Primary', { tag: item.ImageTags.Primary });
                }
                if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                    push(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag });
                }
                if (item.SeriesId) {
                    push(item.SeriesId, 'Backdrop', { index: 0 });
                    if (item.SeriesPrimaryImageTag) {
                        push(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag });
                    } else {
                        push(item.SeriesId, 'Primary', {});
                    }
                }
            } else if (item.ImageTags && item.ImageTags.Primary) {
                push(item.Id, 'Primary', { tag: item.ImageTags.Primary });
            }
        }

        // Biztos fallback a jelenlegi item Backdropjára
        push(itemId, 'Backdrop', { index: 0 });
        push(itemId, 'Primary', {});

        const unique = [...new Set(candidates.filter(Boolean))];
        for (const url of unique) {
            if (await imageUrlExists(url)) {
                return url;
            }
        }
        return unique[0] || null;
    }

    async function startDetailTrailer(detailPage, itemId) {
        let backdropEl = detailPage.querySelector('.detail-hero-backdrop');
        if (!backdropEl) return;

        let videoWrapper = backdropEl.querySelector('.detail-video-wrapper');
        if (!videoWrapper) {
            videoWrapper = document.createElement('div');
            videoWrapper.className = 'detail-video-wrapper';
            backdropEl.appendChild(videoWrapper);
        }

        // Epizód: csak kép, nincs előzetes
        const itemData = await getItemDetails(itemId);
        if (itemData && itemData.Type === 'Episode') {
            videoWrapper.innerHTML = '';
            delete backdropEl.dataset.trailerItemId;
            return;
        }

        // Ha már fut vagy be van töltve ugyanerre a filmre, nem indítjuk újra feleslegesen
        if (backdropEl.dataset.trailerItemId === itemId && videoWrapper.children.length > 0) {
            return;
        }
        backdropEl.dataset.trailerItemId = itemId;

        const client = getApiClient();
        if (!client) return;

        // 1. Helyi trailer keresése
        const localTrailer = await getLocalTrailer(itemId);
        if (localTrailer) {
            if (lastHandledDetailItemId !== itemId) return;
            const streamUrl = client.getUrl('/Videos/' + localTrailer.Id + '/stream', { static: true });
            const video = document.createElement('video');
            video.className = 'detail-hero-video';
            video.src = streamUrl;
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.loop = true;
            video.onplaying = () => {
                video.classList.add('is-active');
            };
            videoWrapper.innerHTML = '';
            videoWrapper.appendChild(video);
            currentDetailVideo = video;
            return;
        }

        // 2. YouTube előzetes keresése
        if (itemData && itemData.RemoteTrailers && itemData.RemoteTrailers.length > 0) {
            if (lastHandledDetailItemId !== itemId) return;
            for (const rt of itemData.RemoteTrailers) {
                const ytId = extractYouTubeId(rt.Url);
                if (ytId) {
                    const iframe = document.createElement('iframe');
                    iframe.className = 'detail-hero-video detail-youtube-iframe';
                    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
                    const origin = encodeURIComponent(window.location.origin);
                    iframe.src = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${ytId}&playsinline=1&rel=0&enablejsapi=1&origin=${origin}`;
                    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
                    iframe.frameBorder = '0';
                    iframe.tabIndex = -1;
                    iframe.onload = () => {
                        setTimeout(() => iframe.classList.add('is-active'), 600);
                    };
                    setTimeout(() => {
                        if (iframe && !iframe.classList.contains('is-active')) {
                            iframe.classList.add('is-active');
                        }
                    }, 1200);

                    videoWrapper.innerHTML = '';
                    videoWrapper.appendChild(iframe);
                    return;
                }
            }
        }
    }

    async function setupDetailBackdrop(detailPage, itemId) {
        const client = getApiClient();
        if (!client) return;

        let backdropEl = detailPage.querySelector('.detail-hero-backdrop');
        if (!backdropEl) {
            backdropEl = document.createElement('div');
            backdropEl.className = 'detail-hero-backdrop';
            detailPage.insertBefore(backdropEl, detailPage.firstChild);
        }

        let videoWrapper = backdropEl.querySelector('.detail-video-wrapper');
        if (!videoWrapper) {
            videoWrapper = document.createElement('div');
            videoWrapper.className = 'detail-video-wrapper';
            backdropEl.appendChild(videoWrapper);
        }

        const imageUrl = await resolveDetailHeroImageUrl(itemId);
        if (lastHandledDetailItemId !== itemId) return;

        if (imageUrl && (backdropEl.dataset.backdropUrl !== imageUrl || !backdropEl.style.backgroundImage)) {
            backdropEl.dataset.backdropItemId = itemId;
            backdropEl.dataset.backdropUrl = imageUrl;
            backdropEl.style.backgroundImage = 'url("' + imageUrl + '")';
        }

        // Epizód: csak kép; film/sorozat: trailer is mehet
        const itemData = await getItemDetails(itemId);
        if (itemData && itemData.Type === 'Episode') {
            videoWrapper.innerHTML = '';
            delete backdropEl.dataset.trailerItemId;
            return;
        }

        startDetailTrailer(detailPage, itemId);
    }

    function setupDetailLogo(detailPage, itemId) {
        const client = getApiClient();
        if (!client) return;

        const nameContainer = detailPage.querySelector('.nameContainer') || detailPage.querySelector('.itemName');
        if (!nameContainer) return;

        let logoEl = detailPage.querySelector('.custom-detail-logo');
        if (!logoEl) {
            logoEl = document.createElement('div');
            logoEl.className = 'custom-detail-logo';
            nameContainer.parentNode.insertBefore(logoEl, nameContainer);
        }

        const originalLogo = detailPage.querySelector('.detailLogo');
        if (originalLogo && originalLogo !== logoEl) {
            originalLogo.style.display = 'none';
        }

        const logoUrl = client.getUrl('/Items/' + itemId + '/Images/Logo', {
            quality: 90,
            maxWidth: 500
        });

        if (logoEl.dataset.logoItemId !== itemId) {
            logoEl.dataset.logoItemId = itemId;
            logoEl.style.backgroundImage = 'url("' + logoUrl + '")';

            const testImg = new Image();
            testImg.onload = () => {
                if (lastHandledDetailItemId === itemId && detailPage.contains(logoEl)) {
                    detailPage.classList.add('has-detail-logo');
                    logoEl.style.display = 'block';
                    enforceLeftAlignment(detailPage);
                }
            };
            testImg.onerror = () => {
                if (lastHandledDetailItemId === itemId) {
                    detailPage.classList.remove('has-detail-logo');
                    if (logoEl) logoEl.style.display = 'none';
                    enforceLeftAlignment(detailPage);
                }
            };
            testImg.src = logoUrl;
        } else {
            detailPage.classList.add('has-detail-logo');
            logoEl.style.display = 'block';
        }
    }

    function triggerDetailInitialFocus(detailPage) {
        if (detailFocusTimeout) clearTimeout(detailFocusTimeout);

        let attempts = 0;
        const maxAttempts = 20;

        function tryFocus() {
            const playBtn = detailPage.querySelector('.btnPlaySimple') ||
                            detailPage.querySelector('.btnPlay') ||
                            detailPage.querySelector('.mainDetailButtons button');

            if (playBtn && document.contains(playBtn)) {
                // Ne görgessen a Playhez — a hero teteje maradjon látható
                setElementFocus(playBtn, { preventScroll: true });
                resetScrollToTop(detailPage);
                // A focusManager / layout késleltetett scrollját is visszaütjük
                setTimeout(() => resetScrollToTop(detailPage), 50);
                setTimeout(() => resetScrollToTop(detailPage), 200);
                setTimeout(() => resetScrollToTop(detailPage), 500);
            } else if (++attempts < maxAttempts) {
                detailFocusTimeout = setTimeout(tryFocus, 80);
            }
        }

        detailFocusTimeout = setTimeout(tryFocus, 60);
    }

    function isElementVisible(el) {
        if (!el) return false;
        if (el.closest('.hide')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        // emby-select mérete TV-n gyakran 0x0 a getBoundingClientRect szerint — selectnél ezt ne szűrjük
        if (el.tagName === 'SELECT') return true;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function getTrackSelects(detailPage) {
        // Jellyfin: select.selectSource / selectVideo / selectAudio / selectSubtitles (emby-select)
        const ordered = [];
        const seen = new Set();
        const push = (el) => {
            if (!el || seen.has(el)) return;
            if (el.disabled) return;
            if (el.closest('.hide')) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            // A wraper .selectContainer.hide is kizár
            const wrap = el.closest('.selectContainer');
            if (wrap && wrap.classList.contains('hide')) return;
            seen.add(el);
            ordered.push(el);
        };

        detailPage.querySelectorAll(
            '.trackSelections select.selectSource, .trackSelections select.selectVideo, ' +
            '.trackSelections select.selectAudio, .trackSelections select.selectSubtitles'
        ).forEach(push);

        // Maradék track select a formban + primary content selectek
        detailPage.querySelectorAll(
            '.trackSelections select, select.detailTrackSelect, ' +
            '.detailPagePrimaryContent select.selectAudio, .detailPagePrimaryContent select.selectSubtitles, ' +
            '.detailPagePrimaryContent select'
        ).forEach(push);

        return ordered;
    }

    function isDetailFocusCandidate(el, buttonsBar, detailPage) {
        if (!el || !detailPage.contains(el)) return false;
        if (buttonsBar && buttonsBar.contains(el)) return false;
        if (el.closest('.detail-hero-backdrop, .detail-video-wrapper, .skinHeader')) return false;
        if (el.tagName === 'IFRAME') return false;
        if (!isElementVisible(el)) return false;
        return true;
    }

    function resolveFocusable(el) {
        if (!el) return null;
        if (el.matches('button, a, select, input, [tabindex="0"], [tabindex]:not([tabindex="-1"])')) return el;
        return el.querySelector(
            'button, a, select, input, [tabindex="0"], [tabindex]:not([tabindex="-1"])'
        ) || el;
    }

    function collectDownTargetsFromButtons(detailPage, buttonsBar) {
        const targets = [];
        const seen = new Set();
        const add = (el) => {
            const focusable = resolveFocusable(el);
            if (!focusable || seen.has(focusable)) return;
            if (!isDetailFocusCandidate(focusable, buttonsBar, detailPage)) return;
            seen.add(focusable);
            targets.push(focusable);
        };

        // 1. Track selectek DOM-sorrendben (verzió → hang → felirat) — film / kiválasztott epizód
        getTrackSelects(detailPage).forEach(add);

        // 2. Egyéb primary tartalom a gombsor alatt (áttekintés linkek stb.)
        const buttonsRect = buttonsBar ? buttonsBar.getBoundingClientRect() : null;
        detailPage.querySelectorAll(
            '.detailPagePrimaryContent button, .detailPagePrimaryContent a, ' +
            '.detailPagePrimaryContent [tabindex="0"]'
        ).forEach(el => {
            if (buttonsRect) {
                const r = el.getBoundingClientRect();
                if (r.top < buttonsRect.bottom - 20) return;
            }
            add(el);
        });

        // 3. Évad / epizód / Next Up (sorozat főoldal — track select nélkül)
        [
            '.childrenItemsContainer .card',
            '.seasonsSection .card',
            '.nextUpSection .card'
        ].forEach(sel => {
            detailPage.querySelectorAll(sel).forEach(add);
        });

        // 4. Alsó szekciók (szereplők, hasonló) — csak a fentiek után
        detailPage.querySelectorAll(
            '.detailPageSecondaryContainer .card, .detailPageSecondaryContainer button, ' +
            '.detailPageSecondaryContainer a, .detailPageSecondaryContainer [tabindex="0"]'
        ).forEach(add);

        return targets;
    }

    function focusDownFromButtons(detailPage, buttonsBar) {
        const targets = collectDownTargetsFromButtons(detailPage, buttonsBar);
        for (const target of targets) {
            if (setElementFocus(target)) {
                try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
                return target;
            }
        }
        return null;
    }

    function focusDetailPlayButton(detailPage) {
        const playBtn = detailPage.querySelector('.btnPlaySimple') ||
            detailPage.querySelector('.btnPlay') ||
            detailPage.querySelector('.mainDetailButtons button');
        if (!playBtn) return false;

        resetScrollToTop(detailPage);
        let ok = setElementFocus(playBtn, { preventScroll: true });
        if (!ok) {
            try { playBtn.focus({ preventScroll: true }); } catch {}
            try {
                if (window.focusManager && typeof window.focusManager.focus === 'function') {
                    window.focusManager.focus(playBtn);
                }
            } catch {}
        }
        resetScrollToTop(detailPage);
        setTimeout(() => resetScrollToTop(detailPage), 50);
        setTimeout(() => resetScrollToTop(detailPage), 200);
        return document.activeElement === playBtn ||
            !!(playBtn.contains && playBtn.contains(document.activeElement)) ||
            !!(detailPage.querySelector('.mainDetailButtons') &&
                detailPage.querySelector('.mainDetailButtons').contains(document.activeElement));
    }

    function resolveActiveTrackSelect(detailPage, active) {
        const selects = getTrackSelects(detailPage);
        if (!active || !detailPage.contains(active)) return { selects, index: -1 };

        // 1. Közvetlen select match
        let index = selects.indexOf(active);
        if (index >= 0) return { selects, index };

        // 2. active maga SELECT a detail oldalon (nem volt a listában — adjuk hozzá)
        if (active.tagName === 'SELECT') {
            const inTracks = !!active.closest('.trackSelections, .detailPagePrimaryContent');
            if (inTracks) {
                const extended = selects.slice();
                if (!extended.includes(active)) extended.push(active);
                return { selects: extended, index: extended.indexOf(active) };
            }
        }

        // 3. selectContainer / label / nyíl
        const container = active.closest
            ? active.closest('.selectContainer, .detailsGroupItem')
            : null;
        if (container) {
            const sel = container.querySelector('select');
            if (sel) {
                index = selects.indexOf(sel);
                if (index >= 0) return { selects, index };
                const extended = selects.slice();
                extended.push(sel);
                return { selects: extended, index: extended.length - 1 };
            }
        }

        // 4. Bármi a .trackSelections formban
        if (active.closest && active.closest('.trackSelections')) {
            if (selects.length === 1) return { selects, index: 0 };
            if (selects.length > 0) {
                const ar = active.getBoundingClientRect();
                let best = 0;
                let bestDist = Infinity;
                selects.forEach((s, i) => {
                    const r = s.getBoundingClientRect();
                    const dist = Math.abs((r.top + r.bottom) / 2 - (ar.top + ar.bottom) / 2);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = i;
                    }
                });
                return { selects, index: best };
            }
        }

        return { selects, index: -1 };
    }

    function bindDetailNavKeys(detailPage) {
        enforceLeftAlignment(detailPage);
    }

    // Globális capture-fázisú billentyűzetkezelő az adatlapon a lefelé/felfelé navigációhoz
    window.addEventListener('keydown', (e) => {
        const detailPage = document.querySelector('.itemDetailPage:not(.hide)') || document.querySelector('.itemDetailPage');
        if (!detailPage) return;
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

        const active = document.activeElement;
        const buttonsBar = detailPage.querySelector('.mainDetailButtons');
        const isButtonActive = buttonsBar && active && (
            buttonsBar.contains(active) ||
            active.classList.contains('btnPlaySimple') ||
            active.classList.contains('btnPlay') ||
            !!active.closest('.mainDetailButtons')
        );
        const { selects: trackSelects, index: trackIndex } = resolveActiveTrackSelect(detailPage, active);
        const isTrackSelectActive = trackIndex >= 0;

        if (e.key === 'ArrowDown' && isButtonActive) {
            const focused = focusDownFromButtons(detailPage, buttonsBar);
            if (!focused) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        } else if (e.key === 'ArrowDown' && isTrackSelectActive) {
            let nextTarget = trackSelects[trackIndex + 1] || null;
            if (!nextTarget) {
                const allBelow = collectDownTargetsFromButtons(detailPage, buttonsBar);
                const currentSel = trackSelects[trackIndex];
                const currentIdx = allBelow.indexOf(currentSel);
                nextTarget = currentIdx >= 0
                    ? allBelow.slice(currentIdx + 1).find(Boolean)
                    : allBelow.find(t => !trackSelects.includes(t));
            }
            if (!nextTarget || !setElementFocus(nextTarget)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            try { nextTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
        } else if (e.key === 'ArrowUp' && isTrackSelectActive) {
            // CSAK a track select lánc: felirat → hang → Play
            // Alsó kártyákról NE ugorjunk ide — azt a natív spatial nav intézi
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (trackIndex > 0) {
                const prev = trackSelects[trackIndex - 1];
                setElementFocus(prev, { preventScroll: true });
                try { prev.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
                return;
            }
            focusDetailPlayButton(detailPage);
        } else if (e.key === 'ArrowUp' && isButtonActive) {
            const backBtn = document.querySelector('.headerBackButton') || document.querySelector('.skinHeader button');
            if (backBtn && setElementFocus(backBtn, { preventScroll: true })) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }
        // Minden más ArrowUp/Down: natív Jellyfin spatial navigation
    }, true);

    // Navigáció figyelése (SPA útvonalváltások)
    let lastUrl = window.location.href;
    function onRouteChanged() {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
        }
        retryCount = 0;
        if (isHomePage()) {
            stopDetailTrailer();
            initHeroBanner();
        } else if (isItemDetailPage()) {
            stopTrailer();
            enhanceItemDetailPage();
            setTimeout(enhanceItemDetailPage, 100);
            setTimeout(enhanceItemDetailPage, 300);
            setTimeout(enhanceItemDetailPage, 700);
        } else {
            stopTrailer();
            stopDetailTrailer();
        }
    }

    // History API hook a gyors SPA reakcióhoz
    const originalPushState = history.pushState;
    if (originalPushState) {
        history.pushState = function () {
            const ret = originalPushState.apply(this, arguments);
            onRouteChanged();
            return ret;
        };
    }
    const originalReplaceState = history.replaceState;
    if (originalReplaceState) {
        history.replaceState = function () {
            const ret = originalReplaceState.apply(this, arguments);
            onRouteChanged();
            return ret;
        };
    }

    setInterval(() => {
        if (window.location.href !== lastUrl) {
            onRouteChanged();
        }
    }, 200);

    window.addEventListener('hashchange', onRouteChanged);
    window.addEventListener('popstate', onRouteChanged);
    document.addEventListener('viewshow', onRouteChanged);

    // DOM figyelő, hogy a home és a részletek oldal betöltésekor azonnal megjelenjen
    const observer = new MutationObserver(() => {
        if (isHomePage()) {
            if (!document.querySelector('.hero-banner')) {
                initHeroBanner();
            }
        } else if (isItemDetailPage()) {
            const detailPage = document.querySelector('.itemDetailPage:not(.hide)') || document.querySelector('.itemDetailPage');
            if (detailPage) {
                const itemId = getItemIdFromUrl() || detailPage.getAttribute('data-id');
                const hasBackdrop = !!detailPage.querySelector('.detail-hero-backdrop');
                const hasLogo = !!detailPage.querySelector('.custom-detail-logo');
                if (itemId && (!hasBackdrop || !hasLogo || lastHandledDetailItemId !== itemId)) {
                    enhanceItemDetailPage();
                } else {
                    enforceLeftAlignment(detailPage);
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Kezdeti indítás
    function onPageReady() {
        if (isHomePage()) {
            initHeroBanner();
        } else if (isItemDetailPage()) {
            enhanceItemDetailPage();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onPageReady);
    } else {
        onPageReady();
    }
})();
