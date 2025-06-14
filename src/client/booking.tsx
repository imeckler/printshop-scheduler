/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { getAvailableSlots, bookSlot, isSuccessResponse } from './apiClient';
import { AvailableSlot } from '../lib/apiTypes';

interface TimeSlotOption {
  timeRange: string;
  slot: AvailableSlot;
  availableCount: number;
}

class BookingManager {
  private dateInput: HTMLInputElement;
  private timeSelect: HTMLSelectElement;
  private slotsContainer: HTMLElement;
  private loadingDiv: HTMLElement;

  constructor() {
    this.dateInput = document.getElementById('bookingDate') as HTMLInputElement;
    this.timeSelect = document.getElementById('timeSelect') as HTMLSelectElement;
    this.slotsContainer = document.getElementById('slotsContainer') as HTMLElement;
    this.loadingDiv = document.getElementById('loading') as HTMLElement;

    this.setupEventListeners();
    this.populateTimeOptions();
    this.loadAvailableSlots();
  }

  private setupEventListeners(): void {
    this.dateInput.addEventListener('change', this.loadAvailableSlots.bind(this));
    this.timeSelect.addEventListener('change', this.loadAvailableSlots.bind(this));
  }

  private populateTimeOptions(): void {
    const allDayOption = <option value="all-day">All day</option>;
    this.timeSelect.appendChild(allDayOption);

    for (let hour = 6; hour <= 22; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        const displayTime = new Date(`2000-01-01T${timeString}`).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

        const option = <option value={timeString}>{displayTime}</option>;
        this.timeSelect.appendChild(option);
      }
    }
  }

  private getTimeRange(): { start: Date; end: Date } {
    const selectedDate = new Date(this.dateInput.value);
    const selectedTime = this.timeSelect.value;

    if (selectedTime === 'all-day') {
      const startDate = new Date(selectedDate);
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(selectedDate);
      endDate.setHours(23, 59, 59, 999);

      return { start: startDate, end: endDate };
    } else {
      const [hour, minute] = selectedTime.split(':').map(Number);

      const startDate = new Date(selectedDate);
      startDate.setHours(hour - 1, minute, 0, 0);

      const endDate = new Date(selectedDate);
      endDate.setHours(hour + 2, minute, 0, 0);

      return { start: startDate, end: endDate };
    }
  }

  private async loadAvailableSlots(): Promise<void> {
    this.showLoading(true);

    const { start, end } = this.getTimeRange();

    try {
      const result = await getAvailableSlots({
        start: start.toISOString(),
        stop: end.toISOString(),
      });

      if (isSuccessResponse(result)) {
        this.renderTimeSlots(result.data);
      } else {
        this.showError(result.error);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        window.location.href = '/login';
        return;
      }
      this.showError('Network error. Please try again.');
    } finally {
      this.showLoading(false);
    }
  }

  private renderTimeSlots(slots: AvailableSlot[]): void {
    this.slotsContainer.innerHTML = '';

    if (slots.length === 0) {
      const noSlotsMsg = <p>No available slots for the selected time range.</p>;
      this.slotsContainer.appendChild(noSlotsMsg);
      return;
    }

    const timeSlotOptions = this.processTimeSlots(slots);

    const flexContainer = (
      <div className="time-slots-flex">
        {timeSlotOptions.map(timeSlotOption => this.TimeSlotCard({ timeSlotOption }))}
      </div>
    );

    this.slotsContainer.appendChild(flexContainer);
  }

  private TimeSlotCard({ timeSlotOption }: { timeSlotOption: TimeSlotOption }) {
    return (
      <div className="time-slot-card" onClick={() => this.bookSlot(timeSlotOption.slot)}>
        <div className="time-slot-time">{timeSlotOption.timeRange}</div>
        <div className="time-slot-price">${(timeSlotOption.slot.price / 100).toFixed(2)}</div>
        <div className="time-slot-availability">
          {timeSlotOption.availableCount} unit{timeSlotOption.availableCount !== 1 ? 's' : ''}{' '}
          available
        </div>
      </div>
    );
  }

  private processTimeSlots(slots: AvailableSlot[]): TimeSlotOption[] {
    const slotsByTime = new Map<string, AvailableSlot[]>();

    slots.forEach(slot => {
      const timeKey = this.formatTime(slot.slot.start) + ' - ' + this.formatTime(slot.slot.end);
      if (!slotsByTime.has(timeKey)) {
        slotsByTime.set(timeKey, []);
      }
      slotsByTime.get(timeKey)!.push(slot);
    });

    const timeSlotOptions: TimeSlotOption[] = [];

    slotsByTime.forEach((unitsForTime, timeRange) => {
      unitsForTime.sort((a, b) => a.unitId - b.unitId);
      const selectedSlot = unitsForTime[0];

      timeSlotOptions.push({
        timeRange,
        slot: selectedSlot,
        availableCount: unitsForTime.length,
      });
    });

    timeSlotOptions.sort(
      (a, b) => new Date(a.slot.slot.start).getTime() - new Date(b.slot.slot.start).getTime()
    );

    return timeSlotOptions;
  }

  public async bookSlot(slot: AvailableSlot): Promise<void> {
    if (!confirm(`Book this slot for $${(slot.price / 100).toFixed(2)}?`)) {
      return;
    }

    try {
      const result = await bookSlot(slot);

      if (isSuccessResponse(result)) {
        alert('Booking successful! Redirecting to home page...');
        window.location.href = '/';
      } else {
        alert('Booking failed: ' + result.error);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        window.location.href = '/login';
        return;
      }
      alert('Network error. Please try again.');
    }
  }

  private formatTime(isoString: string): string {
    return new Date(isoString).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  private showLoading(show: boolean): void {
    this.loadingDiv.style.display = show ? 'block' : 'none';
    this.slotsContainer.style.display = show ? 'none' : 'block';
  }

  private showError(message: string): void {
    this.slotsContainer.innerHTML = '';
    const errorMsg = <p style="color: red;">Error: {message}</p>;
    this.slotsContainer.appendChild(errorMsg);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BookingManager();
});
