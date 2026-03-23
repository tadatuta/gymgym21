// Mock Telegram WebApp for local development
if (import.meta.env.DEV) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;

    // Ensure Telegram object exists
    if (!win.Telegram) {
        win.Telegram = {};
    }

    // Ensure WebApp object exists
    if (!win.Telegram.WebApp) {
        win.Telegram.WebApp = {};
    }

    // Only patch if we are not in a real Telegram environment (initData is empty)
    if (!win.Telegram.WebApp.initData) {
        console.log('🛠 Starting in Local Dev Mode with Mock Telegram WebApp');

        const mockUser = {
            id: 123456789,
            first_name: 'Local',
            last_name: 'Dev',
            username: 'local_developer',
            language_code: 'en',
            allows_write_to_pm: true,
            photo_url: 'https://cdn4.iconfinder.com/data/icons/avatars-xmas-giveaway/128/batman_hero_avatar_comics-512.png'
        };

        const mockInitData = new URLSearchParams({
            query_id: 'AAEAA...',
            user: JSON.stringify(mockUser),
            auth_date: Math.floor(Date.now() / 1000).toString(),
            hash: 'mock_hash_for_local_dev'
        }).toString();

        win.Telegram.WebApp = {
            initData: mockInitData,
            initDataUnsafe: {
                query_id: 'AAEAA...',
                user: mockUser,
                auth_date: Math.floor(Date.now() / 1000),
                hash: 'mock_hash_for_local_dev'
            },
            version: '6.0',
            platform: 'unknown',
            colorScheme: 'light',
            themeParams: {
                bg_color: '#ffffff',
                text_color: '#000000',
                hint_color: '#999999',
                link_color: '#2481cc',
                button_color: '#2481cc',
                button_text_color: '#ffffff',
                secondary_bg_color: '#f4f4f5'
            },
            isExpanded: true,
            viewportHeight: window.innerHeight,
            viewportStableHeight: window.innerHeight,
            headerColor: '#ffffff',
            backgroundColor: '#ffffff',

            // Methods
            ready: () => console.log('[MockTg] WebApp.ready()'),
            expand: () => console.log('[MockTg] WebApp.expand()'),
            close: () => console.log('[MockTg] WebApp.close()'),
            enableClosingConfirmation: () => console.log('[MockTg] enableClosingConfirmation'),
            disableClosingConfirmation: () => console.log('[MockTg] disableClosingConfirmation'),
            isVersionAtLeast: () => true,

            onEvent: (eventType: string) => console.log(`[MockTg] onEvent: ${eventType}`),
            offEvent: (eventType: string) => console.log(`[MockTg] offEvent: ${eventType}`),
            sendData: (data: string) => console.log(`[MockTg] sendData:`, data),

            // UI Components
            BackButton: {
                isVisible: false,
                onClick: () => console.log('[MockTg] BackButton.onClick'),
                offClick: () => console.log('[MockTg] BackButton.offClick'),
                show: () => console.log('[MockTg] BackButton.show()'),
                hide: () => console.log('[MockTg] BackButton.hide()')
            },
            MainButton: {
                text: 'CONTINUE',
                color: '#2481cc',
                textColor: '#ffffff',
                isVisible: false,
                isActive: true,
                isProgressVisible: false,
                setText: (text: string) => console.log(`[MockTg] MainButton.setText: ${text}`),
                onClick: () => console.log('[MockTg] MainButton.onClick'),
                offClick: () => console.log('[MockTg] MainButton.offClick'),
                show: () => console.log('[MockTg] MainButton.show()'),
                hide: () => console.log('[MockTg] MainButton.hide()'),
                enable: () => console.log('[MockTg] MainButton.enable()'),
                disable: () => console.log('[MockTg] MainButton.disable()'),
                showProgress: () => console.log('[MockTg] MainButton.showProgress()'),
                hideProgress: () => console.log('[MockTg] MainButton.hideProgress()'),
                setParams: (params: Record<string, unknown>) => console.log('[MockTg] MainButton.setParams:', params),
            },

            // Telegram link opening
            openTelegramLink: (url: string) => {
                console.log(`[MockTg] openTelegramLink: ${url}`);
                // In dev mode, open in new tab to simulate behavior
                window.open(url, '_blank');
            },
            HapticFeedback: {
                impactOccurred: (style: string) => console.log(`[MockTg] Haptic.impact: ${style}`),
                notificationOccurred: (type: string) => console.log(`[MockTg] Haptic.notification: ${type}`),
                selectionChanged: () => console.log('[MockTg] Haptic.selectionChanged'),
            }
        };

        // Apply theme params to body to simulate Telegram theme
        document.documentElement.style.setProperty('--tg-theme-bg-color', win.Telegram.WebApp.themeParams.bg_color);
        document.documentElement.style.setProperty('--tg-theme-text-color', win.Telegram.WebApp.themeParams.text_color);
        document.documentElement.style.setProperty('--tg-theme-hint-color', win.Telegram.WebApp.themeParams.hint_color);
        document.documentElement.style.setProperty('--tg-theme-link-color', win.Telegram.WebApp.themeParams.link_color);
        document.documentElement.style.setProperty('--tg-theme-button-color', win.Telegram.WebApp.themeParams.button_color);
        document.documentElement.style.setProperty('--tg-theme-button-text-color', win.Telegram.WebApp.themeParams.button_text_color);
        document.documentElement.style.setProperty('--tg-theme-secondary-bg-color', win.Telegram.WebApp.themeParams.secondary_bg_color);
    }
}
