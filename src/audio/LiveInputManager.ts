export interface AudioInputDevice {
  deviceId: string;
  label: string;
  isBlackHole: boolean;
}

export class LiveInputManager {
  private activeStream: MediaStream | null = null;
  private selectedDeviceId: string | null = null;

  public async getAvailableAudioDevices(): Promise<AudioInputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'audioinput')
        .map((d, index) => {
          const label = d.label || `Audio Input ${index + 1}`;
          const isBlackHole = label.toLowerCase().includes('blackhole');
          return {
            deviceId: d.deviceId,
            label,
            isBlackHole,
          };
        });
    } catch (err) {
      console.warn('Failed to enumerate audio devices:', err);
      return [];
    }
  }

  public async startStream(deviceId?: string): Promise<MediaStream> {
    this.stopStream();

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.activeStream = stream;
    this.selectedDeviceId = deviceId || null;
    return stream;
  }

  public stopStream(): void {
    if (this.activeStream) {
      this.activeStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      });
      this.activeStream = null;
    }
  }

  public getStream(): MediaStream | null {
    return this.activeStream;
  }

  public getSelectedDeviceId(): string | null {
    return this.selectedDeviceId;
  }
}
